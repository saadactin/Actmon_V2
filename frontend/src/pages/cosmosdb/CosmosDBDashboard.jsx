import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, Boxes, Clock, Database, FileJson, ListTree, Sparkles,
} from 'lucide-react';

import { errorText } from '@/api/client';
import { getConnectionDetails } from '@/api/connections';
import * as cosmos from '@/api/cosmos';
import EngineDashboardHeader from '@/components/layout/EngineDashboardHeader';
import ChartCard from '@/components/charts/ChartCard';
import LineChart from '@/components/charts/LineChart';
import { STATUS } from '@/components/charts/status';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Dialog from '@/components/ui/Dialog';
import Drawer from '@/components/ui/Drawer';
import Icon from '@/components/ui/Icon';
import Input from '@/components/ui/Input';
import Notice from '@/components/ui/Notice';
import Select from '@/components/ui/Select';
import Table, { EmptyState } from '@/components/ui/Table';
import Tooltip from '@/components/ui/Tooltip';
import { InlineLoading, PageLoading } from '@/components/ui/Loading';
import { Paged } from '@/components/ui/Pagination';
import Toasts, { useToasts } from '@/components/ui/Toast';
import { DashboardScopeProvider } from '@/context/DashboardAppearanceContext';

import ObjectTable from '@/pages/_shared/ObjectTable';
import {
  DefGrid, MetricTile, Panel, StatCell, StatusPill, TablePanel,
} from '@/pages/_shared/enginePanels';
import { AiReportDialog, AiReportPanel, AiRowExplanation } from '@/pages/_shared/aiReport';
import {
  fmtBytes, fmtClock, fmtDateTime, fmtEpochSeconds, fmtNumber,
} from '@/config/dbCatalog';
import {
  COSMOS_CONTAINER_COLUMNS, COSMOS_DATABASE_COLUMNS, COSMOS_SLOW_MS, GapTile,
  INDEXING_MODE_NOTES, INDEX_SECTIONS, indexSizeOf, operationMeta, parseTarget,
  statusMeta, throughputLabel, uniqueKeyPaths,
} from '@/config/cosmosCatalog';

/**
 * Azure Cosmos DB dashboard — eight tabs over a cloud account reached with an
 * endpoint and a key.
 *
 * Cosmos is unlike every other engine here in two ways that shape the whole page:
 *
 *  · Reading costs money. There is no `system.*` to poll for free — every figure
 *    is a real API call billed in Request Units. So nothing here polls the account:
 *    the only thing on an interval is `/activity`, which reads ActMon's own log of
 *    calls it already made and costs nothing. Storage and document counts appear
 *    when a container is opened, and the exact count stays behind a button.
 *
 *  · Some facts genuinely cannot be had. Per-partition distribution, index
 *    utilisation and average document size need Azure Monitor. Rather than print a
 *    dash, each is a `GapTile` that says what is missing and why — see
 *    `config/cosmosCatalog`, where the reasons live.
 *
 * The performance history — response time, RU charge, storage and document growth
 * — is therefore a history of ActMon's own calls, not of the application's traffic.
 * That is said on the page, because a trend line that looks like workload but isn't
 * is worse than no trend line.
 */

const TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'databases', label: 'Databases', icon: Database },
  { id: 'containers', label: 'Containers', icon: Boxes },
  { id: 'documents', label: 'Documents', icon: FileJson },
  { id: 'indexing', label: 'Indexing', icon: ListTree },
  { id: 'slow-queries', label: 'Slow Calls', icon: Clock },
  { id: 'error-logs', label: 'Errors', icon: AlertTriangle },
  { id: 'ai', label: 'Actmon AI', icon: Sparkles },
];

const PAGE_SIZE = 25;
const num = (v) => Number(v) || 0;

/** Health from the call log: connected, connected-with-errors, or failing. */
function healthOf(activity) {
  if (!activity) return null;
  const failures = num(activity.failure_count);
  if (activity.connection_status === 'connected') {
    return failures > 0
      ? { tone: STATUS.warning, label: `Connected · ${failures} recent error${failures === 1 ? '' : 's'}` }
      : { tone: STATUS.good, label: 'Connected' };
  }
  if (activity.connection_status === 'error') return { tone: STATUS.critical, label: 'Last call failed' };
  return { tone: STATUS.unknown, label: 'No calls logged yet' };
}

function HealthBadge({ health }) {
  if (!health) return null;
  return (
    <span
      className="flex h-control shrink-0 items-center gap-1.5 rounded-control px-2.5 text-[12px] font-bold text-white"
      style={{ background: health.tone.color }}
      title="Derived from ActMon's own log of calls to this account — not from Azure Monitor."
    >
      <Icon name="activity" size={13} />
      {health.label}
    </span>
  );
}

export default function CosmosDBDashboard() {
  const { id, tab } = useParams();
  const navigate = useNavigate();
  const { toasts, push, dismiss } = useToasts();

  const activeTab = tab || 'overview';
  const setActiveTab = (t) =>
    navigate(`/cosmosdb-dashboard/${id}${t && t !== 'overview' ? `/${t}` : ''}`);

  const [selectedDb, setSelectedDb] = useState(null);
  const [selectedContainer, setSelectedContainer] = useState(null);
  const [viewingDoc, setViewingDoc] = useState(null);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [explaining, setExplaining] = useState(null);   // the log row in the explain dialog
  const [explanations, setExplanations] = useState({}); // logId → { loading, data, error }
  const [exactCount, setExactCount] = useState(null);   // { loading, value, error }

  /* Documents tab. Cosmos pages by continuation token, so "previous" needs the
     stack of tokens already used — there is no page number to go back to. */
  const [tokenStack, setTokenStack] = useState([]);
  const [token, setToken] = useState(null);
  const [sortRecent, setSortRecent] = useState(false);
  const [filterDraft, setFilterDraft] = useState('');
  const [filterApplied, setFilterApplied] = useState('');

  const [slowContainer, setSlowContainer] = useState('');
  const [slowMinRu, setSlowMinRu] = useState('');
  const [slowMinMs, setSlowMinMs] = useState('');
  const [errStatus, setErrStatus] = useState('');

  /* ── connection & catalogue ──────────────────────────────────────────── */

  const connQ = useQuery({
    queryKey: ['cosmosConnection', id],
    queryFn: () => getConnectionDetails('cosmosdb', id),
    retry: false,
  });
  const conn = connQ.data?.data;
  const primaryDb = conn?.database_name || null;
  const primaryContainer = conn?.container_name || null;

  const dbsQ = useQuery({
    queryKey: ['cosmosDatabases', id],
    queryFn: () => cosmos.listDatabases(id).then((r) => r.data || []),
    retry: false,
  });
  const databases = dbsQ.data || [];

  const containersQ = useQuery({
    queryKey: ['cosmosContainers', id, selectedDb],
    queryFn: () => cosmos.listContainers(id, selectedDb).then((r) => r.data || []),
    enabled: Boolean(selectedDb),
    retry: false,
  });
  const containers = containersQ.data || [];

  /* The connection's configured database wins when it exists; otherwise the first
     one, so the page is never sitting on nothing. */
  useEffect(() => {
    if (!databases.length || selectedDb) return;
    const preferred = primaryDb && databases.some((d) => d.id === primaryDb) ? primaryDb : databases[0].id;
    setSelectedDb(preferred);
  }, [databases, selectedDb, primaryDb]);

  useEffect(() => {
    if (!containers.length) { setSelectedContainer(null); return; }
    if (selectedContainer && containers.some((c) => c.id === selectedContainer)) return;
    const preferred = primaryContainer && containers.some((c) => c.id === primaryContainer)
      ? primaryContainer
      : containers[0].id;
    setSelectedContainer(preferred);
  }, [containers, selectedContainer, primaryContainer]);

  /* Changing either selection invalidates the token stack, the filter and any
     exact count — they all belong to the container that was open. */
  useEffect(() => {
    setTokenStack([]);
    setToken(null);
    setFilterDraft('');
    setFilterApplied('');
    setExactCount(null);
  }, [selectedDb, selectedContainer, sortRecent]);

  /**
   * The one real guard here: when `selectedDb` changes, `selectedContainer` still
   * holds the *previous* database's container for one render, and firing a request
   * with that pair asks Cosmos for a container that does not exist in that
   * database. Requiring the name to be present in the freshly-loaded list closes
   * the window regardless of effect ordering.
   */
  const containerIsValid = Boolean(selectedContainer)
    && containers.some((c) => c.id === selectedContainer);

  /* ── activity: the only thing on an interval, because it costs nothing ── */

  const activityQ = useQuery({
    queryKey: ['cosmosActivity', id],
    queryFn: () => cosmos.activity(id, 200),
    refetchInterval: 30000,
    retry: false,
  });
  const activity = activityQ.data;

  /* ── the connection's own database/container, for the overview ────────── */

  const primaryDetailsQ = useQuery({
    queryKey: ['cosmosContainerDetails', id, primaryDb, primaryContainer],
    queryFn: () => cosmos.containerDetails(id, primaryDb, primaryContainer),
    enabled: Boolean(primaryDb && primaryContainer),
    retry: false,
  });
  const primaryDocsQ = useQuery({
    queryKey: ['cosmosDocStats', id, primaryDb, primaryContainer],
    queryFn: () => cosmos.documentStats(id, primaryDb, primaryContainer),
    enabled: Boolean(primaryDb && primaryContainer),
    retry: false,
  });

  /* ── the selected container, for every other tab ──────────────────────── */

  const detailsQ = useQuery({
    queryKey: ['cosmosContainerDetails', id, selectedDb, selectedContainer],
    queryFn: () => cosmos.containerDetails(id, selectedDb, selectedContainer),
    enabled: Boolean(selectedDb) && containerIsValid,
    retry: false,
  });
  const docStatsQ = useQuery({
    queryKey: ['cosmosDocStats', id, selectedDb, selectedContainer],
    queryFn: () => cosmos.documentStats(id, selectedDb, selectedContainer),
    enabled: Boolean(selectedDb) && containerIsValid && activeTab === 'documents',
    retry: false,
  });

  const itemsQ = useQuery({
    queryKey: ['cosmosItems', id, selectedDb, selectedContainer, token, sortRecent, filterApplied],
    queryFn: () => cosmos.browseItems(id, selectedDb, selectedContainer, {
      limit: PAGE_SIZE,
      continuationToken: token,
      sortRecent,
      filterQuery: filterApplied ? `SELECT * FROM c WHERE ${filterApplied}` : undefined,
    }),
    enabled: activeTab === 'documents' && Boolean(selectedDb) && containerIsValid,
    placeholderData: (prev) => prev,
    retry: false,
  });
  const items = itemsQ.data?.data || [];
  const nextToken = itemsQ.data?.continuation_token || null;

  /* Per-database rollups. Only while the Databases tab is open: each one reads
     every container in that database. */
  const summaries = useQueries({
    queries: databases.map((d) => ({
      queryKey: ['cosmosDbSummary', id, d.id],
      queryFn: () => cosmos.databaseSummary(id, d.id).then((r) => r.data),
      enabled: activeTab === 'databases',
      retry: false,
    })),
  });

  const aiM = useMutation({
    mutationFn: () => cosmos.aiAnalysis(id, selectedDb, selectedContainer),
  });

  const testM = useMutation({
    mutationFn: () => cosmos.testConnection(id),
    onSuccess: (r) => {
      push(r?.message || 'Connection successful', 'success');
      activityQ.refetch();
    },
    onError: (e) => {
      push(`Connection failed — ${errorText(e)}`, 'danger');
      /* A failed test is logged by the backend like any other call, so the
         activity panel and the error tab should show it immediately. */
      activityQ.refetch();
    },
  });

  /* ── derived, in one memo above every early return ────────────────────── */

  const d = useMemo(() => {
    const log = activity || {};
    const recent = log.recent || [];
    const slow = log.slow_queries || [];
    const errors = log.error_logs || [];

    const lastActivityFor = (dbName) => recent.find((r) => {
      const t = parseTarget(r.detail);
      return t.database === dbName || r.detail === dbName;
    })?.created_at || null;

    const dbRows = databases.map((row, i) => {
      const q = summaries[i];
      return {
        ...row,
        summary: q?.data || null,
        loading: Boolean(q?.isLoading),
        error: q?.isError ? (errorText(q.error)) : null,
        lastActivity: lastActivityFor(row.id),
      };
    });

    const containerRows = containers.map((c) => ({
      ...c,
      details: c.id === selectedContainer ? detailsQ.data?.data || null : null,
      detailsLoading: c.id === selectedContainer && detailsQ.isLoading,
    }));

    /* Throttling is the Cosmos failure worth counting separately: it is the
       account refusing work, not the code being wrong. */
    const throttled = errors.filter((e) => Number(e.http_status_code) === 429).length;

    const errorStatuses = [...new Set(errors.map((e) => e.http_status_code).filter((s) => s != null))]
      .sort((a, b) => a - b);

    const slowContainers = [...new Set(slow.map((r) => parseTarget(r.detail).container).filter(Boolean))].sort();

    return {
      recent,
      slow,
      errors,
      throttled,
      errorStatuses,
      slowContainers,
      dbRows,
      containerRows,
      threshold: log.slow_query_threshold_ms ?? COSMOS_SLOW_MS,
      responseTrend: (log.response_time_trend || []).map((p) => ({ label: fmtClock(p.t), value: num(p.v) })),
      ruTrend: (log.request_charge_trend || []).map((p) => ({ label: fmtClock(p.t), value: num(p.v) })),
      storageTrend: (log.storage_growth || []).map((p) => ({
        label: fmtClock(p.t),
        value: +(num(p.v) / 1024 ** 2).toFixed(2),
      })),
      docTrend: (log.document_growth || []).map((p) => ({ label: fmtClock(p.t), value: num(p.v) })),
      operations: (log.operations || []).map((op) => ({
        key: op.type,
        label: operationMeta(op.type).label,
        value: num(op.count),
      })),
    };
  }, [activity, databases, containers, selectedContainer, detailsQ.data, detailsQ.isLoading, summaries]);

  const health = healthOf(activity);
  const primaryDetails = primaryDetailsQ.data?.data;
  const details = detailsQ.data?.data;

  const explain = async (row) => {
    setExplaining(row);
    if (explanations[row.id]) return;
    setExplanations((m) => ({ ...m, [row.id]: { loading: true } }));
    try {
      const r = await cosmos.errorAnalysis(id, row.id);
      setExplanations((m) => ({ ...m, [row.id]: { loading: false, data: r } }));
    } catch (e) {
      setExplanations((m) => ({
        ...m,
        [row.id]: { loading: false, error: errorText(e) },
      }));
    }
  };

  const runExactCount = async () => {
    setExactCount({ loading: true });
    try {
      const r = await cosmos.documentCount(id, selectedDb, selectedContainer);
      setExactCount({ loading: false, value: r.count });
    } catch (e) {
      setExactCount({ loading: false, error: errorText(e) });
    }
  };

  const header = (
    <EngineDashboardHeader
      tech="cosmosdb"
      connectionId={id}
      connection={{
        name: conn?.connection_name,
        host: conn?.endpoint,
        database: [primaryDb, primaryContainer].filter(Boolean).join(' / ') || null,
      }}
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      alerts={{ 'error-logs': d.errors.length, 'slow-queries': d.slow.length }}
      health={(
        <>
          <HealthBadge health={health} />
          <Button variant="secondary" icon="plug" loading={testM.isPending} onClick={() => testM.mutate()}>
            Test
          </Button>
          <Button variant="secondary" icon="settings" onClick={() => navigate(`/cosmosdb-edit/${id}`)}>
            Edit
          </Button>
        </>
      )}
      onRefresh={() => { activityQ.refetch(); dbsQ.refetch(); }}
      isFetching={activityQ.isFetching}
    />
  );

  if (connQ.isLoading) {
    return <DashboardScopeProvider tech="cosmosdb">{header}<PageLoading title="Loading connection…" /></DashboardScopeProvider>;
  }

  const dbSelect = (
    <Select
      value={selectedDb || ''}
      onChange={setSelectedDb}
      options={databases.map((x) => ({ id: x.id, label: x.id }))}
      size="sm"
      width="auto"
      placeholder={databases.length ? undefined : 'No databases'}
    />
  );
  const containerSelect = (
    <Select
      value={selectedContainer || ''}
      onChange={setSelectedContainer}
      options={containers.map((c) => ({ id: c.id, label: c.id }))}
      size="sm"
      width="auto"
      placeholder={containers.length ? undefined : 'No containers'}
    />
  );

  return (
    <DashboardScopeProvider tech="cosmosdb">
      {header}

      {dbsQ.isError && (
        <Notice tone="danger" title="Could not list databases.">
          {errorText(dbsQ.error)}
          {' '}Check the endpoint, the key, and whether this source IP is allowed by the account firewall.
        </Notice>
      )}

      {/* ─────────────── OVERVIEW ─────────────── */}
      {activeTab === 'overview' && (
        <div className="space-y-gutter">
          <Notice tone="info" title="These trends are ActMon's own calls, not your application's traffic.">
            Cosmos exposes no free server-side metrics, so every line below is derived from the calls
            ActMon itself made to this account. Read it as "how this account responded to us", not as
            a workload profile — application traffic needs Azure Monitor.
          </Notice>

          <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-3 xl:grid-cols-6">
            <MetricTile
              label="Calls logged"
              value={fmtNumber(activity?.query_count)}
              icon="activity"
              sub="most recent 200"
            />
            <MetricTile
              label="Avg response"
              value={activity?.avg_response_ms != null ? `${activity.avg_response_ms} ms` : '—'}
              icon="clock"
              tone={num(activity?.avg_response_ms) > d.threshold ? 'warn' : 'neutral'}
            />
            <MetricTile
              label="Last RU charge"
              value={d.recent[0]?.request_charge != null ? `${d.recent[0].request_charge} RU` : '—'}
              icon="zap"
              hint="Request Units billed for the most recent call"
            />
            <MetricTile
              label="Slow calls"
              value={d.slow.length}
              icon="trend"
              tone={d.slow.length ? 'warn' : 'good'}
              sub={`over ${fmtNumber(d.threshold)} ms`}
              onClick={() => setActiveTab('slow-queries')}
            />
            <MetricTile
              label="Errors"
              value={d.errors.length}
              icon="alert"
              tone={d.errors.length ? 'bad' : 'good'}
              onClick={() => setActiveTab('error-logs')}
            />
            <MetricTile
              label="Throttled (429)"
              value={d.throttled}
              icon="gauge"
              tone={d.throttled ? 'warn' : 'good'}
              hint="Calls Cosmos refused because the provisioned RU/s ran out"
            />
          </div>

          {d.throttled > 0 && (
            <Notice tone="warning" title={`${d.throttled} call${d.throttled === 1 ? '' : 's'} were throttled.`}>
              Cosmos returned HTTP 429, which means the container's provisioned throughput was fully
              consumed and it asked the caller to back off. Nothing is broken — the budget ran out.
              Either raise the RU/s, switch the container to autoscale, or make the queries cost less
              by filtering on the partition key.
            </Notice>
          )}

          <div className="grid gap-gutter lg:grid-cols-2">
            <TrendCard
              cardId="cosmos-response"
              title="Response time"
              subtitle="How long each logged call took"
              icon="clock"
              slot={1}
              unit=" ms"
              points={d.responseTrend}
              valueLabel="ms"
            />
            <TrendCard
              cardId="cosmos-ru"
              title="Request charge"
              subtitle="Request Units billed per logged call"
              icon="zap"
              slot={2}
              unit=" RU"
              points={d.ruTrend}
              valueLabel="RU"
              empty="No call has reported an RU charge yet"
            />
            <TrendCard
              cardId="cosmos-storage"
              title="Storage"
              subtitle="Sampled whenever a container was read — not a continuous series"
              icon="database"
              slot={3}
              unit=" MB"
              points={d.storageTrend}
              valueLabel="MB"
              empty="Open a container a few times and its size will plot here"
            />
            {/* A flat breakdown, not a trend: this is a count per operation, and
                the user can flip it to a donut from the card's own picker. */}
            <ChartCard
              cardId="cosmos-ops"
              family="flat"
              title="What ActMon called"
              subtitle="Every logged operation is a read — ActMon never writes to your data"
              icon="list"
              items={d.operations}
              chartProps={{ emptyLabel: 'No calls logged yet' }}
              tableColumns={[
                { key: 'label', label: 'Operation' },
                { key: 'value', label: 'Calls', align: 'right' },
              ]}
              tableRows={d.operations.map((op) => ({ key: op.key, cells: op }))}
            />
          </div>

          <Panel
            title="The connection's own container"
            subtitle={primaryDb && primaryContainer ? `${primaryDb} / ${primaryContainer}` : undefined}
            icon="boxes"
            actions={(
              <Button variant="ghost" size="sm" icon="refresh"
                loading={primaryDetailsQ.isFetching} onClick={() => primaryDetailsQ.refetch()}>
                Re-read
              </Button>
            )}
          >
            {!primaryDb || !primaryContainer ? (
              <Notice tone="info" className="mb-0" title="No database or container is configured on this connection.">
                Pick one on the Containers tab, or set it on the connection so this panel has a subject.
              </Notice>
            ) : primaryDetailsQ.isError ? (
              <Notice tone="danger" className="mb-0" title="Could not read the container.">
                {errorText(primaryDetailsQ.error)}
              </Notice>
            ) : !primaryDetails ? (
              <InlineLoading label="Reading the container…" />
            ) : (
              <ContainerFacts
                details={primaryDetails}
                consistency={conn?.consistency_level}
                docStats={primaryDocsQ.data?.data}
                docStatsError={primaryDocsQ.isError
                  ? (errorText(primaryDocsQ.error))
                  : null}
              />
            )}
          </Panel>

          <Panel title="Partitioning" icon="layers">
            <div className="grid gap-gutter-sm sm:grid-cols-3">
              <StatCell
                label="Estimated physical partitions"
                value={primaryDetails?.estimated_physical_partitions ?? '—'}
                hint="Derived from provisioned RU/s and storage, the same way Microsoft's guidance does it"
              />
              <StatCell
                label="Partition key"
                value={(primaryDetails?.partition_key || []).join(', ') || '—'}
                hint="A query that does not filter on this fans out to every partition"
              />
              <GapTile id="partition_distribution" />
            </div>
          </Panel>
        </div>
      )}

      {/* ─────────────── DATABASES ─────────────── */}
      {activeTab === 'databases' && (
        <div className="space-y-gutter">
          <Notice tone="info" title="Each row's totals are a separate read of every container in that database.">
            That is why they arrive one at a time, and why a database with many containers is summed
            over its first 50 only — flagged on the row when it happens.
          </Notice>

          {dbsQ.isLoading ? (
            <PageLoading title="Listing databases…" />
          ) : (
            <ObjectTable
              title="Databases"
              icon="database"
              columns={COSMOS_DATABASE_COLUMNS}
              items={d.dbRows}
              keyOf={(row) => row.id}
              searchOn={['id']}
              searchPlaceholder="Database name…"
              sizeOf={(row) => num(row.summary?.storage_bytes)}
              defaultSort={{ key: 'storage', dir: 'desc' }}
              onRowClick={(row) => { setSelectedDb(row.id); setActiveTab('containers'); }}
              unit="databases"
              emptyTitle="No databases"
              emptyBody="This Cosmos account has no databases, or the key cannot see them."
            />
          )}
        </div>
      )}

      {/* ─────────────── CONTAINERS ─────────────── */}
      {activeTab === 'containers' && (
        <div className="space-y-gutter">
          <Panel title="Database" icon="database" subtitle="Containers below belong to this database">
            <div className="flex flex-wrap gap-1.5">
              {databases.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => setSelectedDb(x.id)}
                  aria-pressed={selectedDb === x.id}
                  className={`h-control-sm rounded-control px-3 text-[12px] font-semibold transition-colors ${
                    selectedDb === x.id
                      ? 'bg-accent text-accent-fg'
                      : 'border border-border text-muted hover:bg-sunken hover:text-fg'
                  }`}
                >
                  {x.id}
                </button>
              ))}
              {!databases.length && <span className="text-[12px] text-subtle">No databases to choose from.</span>}
            </div>
          </Panel>

          {containersQ.isError && (
            <Notice tone="danger" title="Could not list containers.">
              {errorText(containersQ.error)}
            </Notice>
          )}

          <ObjectTable
            title={`Containers${selectedDb ? ` — ${selectedDb}` : ''}`}
            icon="boxes"
            columns={COSMOS_CONTAINER_COLUMNS}
            items={d.containerRows}
            keyOf={(c) => c.id}
            loading={containersQ.isLoading}
            searchOn={['id']}
            searchPlaceholder="Container name…"
            sizeOf={(c) => num(c.details?.data_size_bytes)}
            onRowClick={(c) => setSelectedContainer(c.id)}
            note="Select a container to read its storage and document count"
            unit="containers"
            emptyTitle="No containers"
            emptyBody={selectedDb ? `${selectedDb} holds no containers.` : 'Pick a database first.'}
          />

          {details && (
            <Panel
              title={`${selectedDb} / ${selectedContainer}`}
              subtitle="Read from Cosmos's own usage header — one container.read(), no data-plane query"
              icon="boxes"
            >
              <ContainerFacts details={details} consistency={conn?.consistency_level} />
            </Panel>
          )}
        </div>
      )}

      {/* ─────────────── DOCUMENTS ─────────────── */}
      {activeTab === 'documents' && (
        <div className="space-y-gutter">
          <Panel
            title="Container"
            icon="boxes"
            actions={<>{dbSelect}{containerSelect}</>}
          >
            <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
              <StatCell
                label="Estimated documents"
                value={details?.estimated_document_count != null
                  ? fmtNumber(details.estimated_document_count)
                  : 'not tracked'}
                hint="Cosmos's own counter, free to read"
              />
              <StatCell
                label="Newest document"
                value={fmtEpochSeconds(docStatsQ.data?.data?.newest_document?._ts) || '—'}
                hint="From _ts, which Cosmos indexes by default"
              />
              <StatCell
                label="Oldest document"
                value={fmtEpochSeconds(docStatsQ.data?.data?.oldest_document?._ts) || '—'}
              />
              <div className="rounded-card bg-sunken px-3 py-2.5">
                <p className="text-[10px] font-bold tracking-wide text-subtle uppercase">Exact count</p>
                {exactCount?.value != null ? (
                  <p className="mt-0.5 text-[16px] font-bold text-fg">{fmtNumber(exactCount.value)}</p>
                ) : exactCount?.error ? (
                  <p className="mt-0.5 text-[11px] leading-snug text-danger-fg">{exactCount.error}</p>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="play"
                    className="mt-1"
                    loading={exactCount?.loading}
                    disabled={!containerIsValid}
                    onClick={runExactCount}
                  >
                    Count now
                  </Button>
                )}
                <p className="mt-1 text-[10px] leading-snug text-subtle">
                  A cross-partition COUNT with a real RU cost, so it only runs when you ask.
                </p>
              </div>
            </div>

            <div className="mt-gutter grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
              <GapTile id="avg_document_size" />
              <GapTile id="largest_document" />
              <GapTile id="write_counts" />
              <GapTile id="partition_distribution" />
            </div>
          </Panel>

          <TablePanel
            title={`Documents${selectedContainer ? ` — ${selectedContainer}` : ''}`}
            icon="type"
            subtitle="Select a row for the whole document"
            actions={(
              <>
                <Button
                  variant={sortRecent ? 'subtle' : 'secondary'}
                  size="sm"
                  icon="clock"
                  onClick={() => setSortRecent((s) => !s)}
                >
                  Recently modified
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="download"
                  disabled={!items.length}
                  onClick={() => downloadFile(
                    JSON.stringify(items, null, 2),
                    `${selectedContainer || 'documents'}.json`,
                    'application/json',
                  )}
                >
                  JSON
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="download"
                  disabled={!items.length}
                  onClick={() => downloadFile(
                    toCsv(items),
                    `${selectedContainer || 'documents'}.csv`,
                    'text/csv',
                  )}
                >
                  CSV
                </Button>
              </>
            )}
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-card py-2.5">
              <Input
                value={filterDraft}
                onChange={(e) => setFilterDraft(e.target.value)}
                onClear={() => { setFilterDraft(''); setFilterApplied(''); setTokenStack([]); setToken(null); }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  setTokenStack([]); setToken(null); setFilterApplied(filterDraft.trim());
                }}
                placeholder="c.status = 'active'"
                icon="filter"
                size="sm"
                className="font-mono"
                wrapperClassName="min-w-0 flex-1"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => { setTokenStack([]); setToken(null); setFilterApplied(filterDraft.trim()); }}
              >
                Apply
              </Button>
              <span className="flex items-center gap-1 text-[11px] text-subtle">
                <Icon name="info" size={11} />
                A Cosmos SQL WHERE clause. It runs against the account, so it costs RU.
              </span>
            </div>

            {filterApplied && (
              <p className="border-b border-border bg-sunken px-card py-2 font-mono text-[11px] text-muted">
                SELECT * FROM c WHERE {filterApplied}
              </p>
            )}

            {itemsQ.isError ? (
              <div className="px-card py-6">
                <Notice tone="danger" className="mb-0" title="The query failed.">
                  {errorText(itemsQ.error)}
                  {filterApplied ? ' Check the WHERE clause — Cosmos rejects it before running anything.' : ''}
                </Notice>
              </div>
            ) : (
              <>
                <Table
                  columns={[
                    { key: 'id', label: 'id' },
                    { key: 'preview', label: 'Document' },
                    { key: 'fields', label: 'Fields', align: 'right' },
                    { key: 'modified', label: 'Last written' },
                  ]}
                  rows={items.map((it, i) => ({
                    key: String(it.id ?? i),
                    onClick: () => setViewingDoc(it),
                    cells: {
                      id: (
                        <span className="font-mono text-[11px] whitespace-nowrap text-accent-text">
                          {it.id || null}
                        </span>
                      ),
                      preview: (
                        <span className="truncate-safe block max-w-[420px] font-mono text-[11px] text-muted">
                          {previewOf(it)}
                        </span>
                      ),
                      fields: (
                        <span className="font-mono text-[12px] text-muted">
                          {Object.keys(it).filter((k) => !k.startsWith('_')).length}
                        </span>
                      ),
                      modified: (
                        <span className="whitespace-nowrap text-[11px] text-muted">
                          {fmtEpochSeconds(it._ts)}
                        </span>
                      ),
                    },
                  }))}
                  loading={itemsQ.isFetching}
                  empty={(
                    <EmptyState
                      icon="type"
                      title={filterApplied ? 'No documents match' : 'No documents'}
                      body={filterApplied
                        ? 'The filter ran successfully and matched nothing.'
                        : 'This container is empty.'}
                    />
                  )}
                />

                {/* Token paging, not page numbers: Cosmos hands back a cursor, so
                    there is no way to jump to page 7 and no total to count against. */}
                <div className="flex items-center justify-between gap-2 border-t border-border px-card py-2.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="chevron-left"
                    disabled={!tokenStack.length}
                    onClick={() => setTokenStack((s) => {
                      if (!s.length) return s;
                      const copy = [...s];
                      setToken(copy.pop() || null);
                      return copy;
                    })}
                  >
                    Previous
                  </Button>
                  <span className="text-[11px] text-subtle">
                    {items.length} shown
                    {tokenStack.length > 0 ? ` · page ${tokenStack.length + 1}` : ''}
                    {nextToken ? '' : ' · end of container'}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    iconRight="chevron-right"
                    disabled={!nextToken}
                    onClick={() => {
                      setTokenStack((s) => [...s, token]);
                      setToken(nextToken);
                    }}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </TablePanel>
        </div>
      )}

      {/* ─────────────── INDEXING ─────────────── */}
      {activeTab === 'indexing' && (
        <div className="space-y-gutter">
          <Panel title="Container" icon="boxes" actions={<>{dbSelect}{containerSelect}</>}>
            <p className="text-[13px] leading-relaxed text-muted">
              Indexing decides what Cosmos can find quickly. Every indexed path makes reads on it
              cheap and adds a little storage and RU to every write; every path left out keeps writes
              cheap and makes filtering on it a full scan. What follows is this container's actual
              policy, with both sides of each choice named.
            </p>
          </Panel>

          {detailsQ.isLoading ? (
            <InlineLoading label="Reading the indexing policy…" />
          ) : detailsQ.isError ? (
            <Notice tone="danger" title="Could not read the container.">
              {errorText(detailsQ.error)}
            </Notice>
          ) : details ? (
            <IndexingTab
              details={details}
              ai={aiM}
              target={`${selectedDb}/${selectedContainer}`}
              onExpand={() => setAiExpanded(true)}
              canRun={Boolean(selectedDb && selectedContainer)}
            />
          ) : (
            <Notice tone="info" title="Pick a container.">
              Nothing is selected yet.
            </Notice>
          )}
        </div>
      )}

      {/* ─────────────── SLOW CALLS ─────────────── */}
      {activeTab === 'slow-queries' && (
        <SlowCallsTab
          rows={d.slow}
          threshold={d.threshold}
          containers={d.slowContainers}
          containerFilter={slowContainer}
          onContainerFilter={setSlowContainer}
          minRu={slowMinRu}
          onMinRu={setSlowMinRu}
          minMs={slowMinMs}
          onMinMs={setSlowMinMs}
          onExplain={explain}
          explanations={explanations}
          loading={activityQ.isLoading}
        />
      )}

      {/* ─────────────── ERRORS ─────────────── */}
      {activeTab === 'error-logs' && (
        <ErrorsTab
          rows={d.errors}
          statuses={d.errorStatuses}
          statusFilter={errStatus}
          onStatusFilter={setErrStatus}
          onExplain={explain}
          explanations={explanations}
          loading={activityQ.isLoading}
        />
      )}

      {/* ─────────────── ACTMON AI ─────────────── */}
      {activeTab === 'ai' && (
        <div className="space-y-gutter">
          <Panel title="Container" icon="boxes" actions={<>{dbSelect}{containerSelect}</>}>
            <p className="text-[13px] leading-relaxed text-muted">
              The report reads real data: this container's health and policies, every sibling
              container in {selectedDb || 'the database'}, a bounded sample of actual documents (so
              schema and null patterns are observed, not guessed), the RU and latency history above,
              and the recent errors. It is slower than a metadata summary because the document sample
              is a genuine query.
            </p>
          </Panel>

          <AiReportPanel
            title="Actmon AI report"
            subtitle={selectedDb && selectedContainer ? `${selectedDb} / ${selectedContainer}` : undefined}
            state={aiM}
            onRun={() => aiM.mutate()}
            onExpand={() => setAiExpanded(true)}
            disabled={!selectedDb || !selectedContainer}
            emptyLabel="Nothing generated yet — run it when you want a read on this container."
            pendingLabel="Sampling real documents and analysing — this can take up to a minute…"
          />
        </div>
      )}

      {/* ─────────────── overlays ─────────────── */}

      <Drawer
        open={Boolean(viewingDoc)}
        onClose={() => setViewingDoc(null)}
        title={viewingDoc?.id ? `Document ${viewingDoc.id}` : 'Document'}
        subtitle={selectedContainer ? `${selectedDb} / ${selectedContainer}` : undefined}
        icon="type"
        width={620}
      >
        {viewingDoc && (
          <div className="space-y-gutter">
            <div className="flex flex-wrap items-center gap-2">
              {viewingDoc._ts && (
                <Badge tone="outline" size="xs">written {fmtEpochSeconds(viewingDoc._ts)}</Badge>
              )}
              <Badge tone="neutral" size="xs">
                {Object.keys(viewingDoc).filter((k) => !k.startsWith('_')).length} fields
              </Badge>
              <span className="ml-auto">
                <CopyButton text={JSON.stringify(viewingDoc, null, 2)} label="Copy JSON" />
              </span>
            </div>
            <pre className="overflow-x-auto rounded-card border border-border bg-sunken px-3 py-2.5 font-mono text-[11px] whitespace-pre-wrap break-words text-fg">
              {JSON.stringify(viewingDoc, null, 2)}
            </pre>
            <p className="text-[11px] leading-relaxed text-subtle">
              Fields beginning with an underscore are Cosmos's own:
              {' '}<span className="font-mono">_ts</span> is the last-write time in Unix seconds,
              {' '}<span className="font-mono">_etag</span> the concurrency token,
              {' '}<span className="font-mono">_rid</span>/<span className="font-mono">_self</span> internal
              addresses.
            </p>
          </div>
        )}
      </Drawer>

      <AiReportDialog
        open={aiExpanded}
        onClose={() => setAiExpanded(false)}
        report={aiM.data}
        target={selectedDb && selectedContainer ? `${selectedDb} / ${selectedContainer}` : undefined}
      />

      <Dialog
        open={Boolean(explaining)}
        onClose={() => setExplaining(null)}
        title={explaining?.success ? 'Why this call was slow' : 'What went wrong'}
        icon="sparkles"
        width={680}
      >
        {explaining && (
          <div className="space-y-gutter">
            <DefGrid
              columns={2}
              rows={[
                { label: 'When', value: fmtDateTime(explaining.created_at) },
                { label: 'Operation', value: operationMeta(explaining.operation).label },
                { label: 'Target', value: explaining.detail || null, mono: true },
                { label: 'Duration', value: explaining.duration_ms != null ? `${explaining.duration_ms} ms` : null },
                {
                  label: 'Request charge',
                  value: explaining.request_charge != null ? `${explaining.request_charge} RU` : null,
                },
                { label: 'Activity ID', value: explaining.activity_id || null, mono: true },
              ]}
            />
            {!explaining.success && explaining.error_message && (
              <Notice tone="danger" className="mb-0" title={explaining.error_type || 'Error'}>
                {explaining.error_message}
              </Notice>
            )}
            <AiRowExplanation state={explanations[explaining.id]} slow={Boolean(explaining.success)} />
          </div>
        )}
      </Dialog>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </DashboardScopeProvider>
  );
}

/* ── trends ───────────────────────────────────────────────────────────────── */

/**
 * One time series in a card, with the table twin the house rules require.
 *
 * `LineChart` rather than a bar list: these are samples over time, and the x-axis
 * spacing is part of the reading. The table shows the most recent 40 newest-first,
 * because that is the direction someone scans a log.
 */
function TrendCard({ cardId, title, subtitle, icon, slot, unit, points, valueLabel, empty }) {
  return (
    <ChartCard
      cardId={cardId}
      title={title}
      subtitle={points.length ? subtitle : undefined}
      icon={icon}
      tableColumns={points.length ? [
        { key: 'time', label: 'Time' },
        { key: 'value', label: valueLabel, align: 'right' },
      ] : undefined}
      tableRows={points.length
        ? points.slice(-40).reverse().map((p, i) => ({
          key: `${p.label}-${i}`,
          cells: { time: p.label, value: p.value },
        }))
        : undefined}
    >
      <LineChart
        data={points}
        color={`var(--chart-${slot})`}
        unit={unit}
        emptyLabel={empty || 'Not enough samples yet'}
        emptyHint="This series is built from ActMon's own calls, so it fills in as the account is used."
      />
    </ChartCard>
  );
}

/* ── container facts ──────────────────────────────────────────────────────── */

/**
 * One container's properties. Shared by the overview and the Containers tab so the
 * two can never disagree about what a container's storage is.
 */
function ContainerFacts({ details, consistency, docStats, docStatsError }) {
  const t = throughputLabel(details);
  const indexSize = indexSizeOf(details);

  return (
    <div className="space-y-gutter">
      <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
        <StatCell label="Partition key" value={(details.partition_key || []).join(', ') || '—'} />
        <StatCell label="Throughput" value={t.value} hint={t.sub} />
        <StatCell label="Storage" value={fmtBytes(details.data_size_bytes)} hint="Documents only, from Cosmos's usage header" />
        <StatCell
          label="Documents"
          value={details.estimated_document_count != null
            ? fmtNumber(details.estimated_document_count)
            : 'not tracked'}
          hint={details.estimated_document_count == null
            ? 'Cosmos returned -1 — it keeps no counter for this container'
            : 'Cosmos\'s own estimate, free to read'}
        />
        <StatCell
          label="Index size"
          value={indexSize != null ? fmtBytes(indexSize) : '—'}
          hint="Collection size minus data size — an estimate, and the only route to it from here"
        />
        <StatCell
          label="Default TTL"
          value={details.default_ttl == null
            ? 'Off'
            : details.default_ttl === -1 ? 'Per document' : `${fmtNumber(details.default_ttl)}s`}
          hint={details.default_ttl == null
            ? 'Documents are kept until something deletes them'
            : 'Documents are removed this long after their last write'}
        />
        <StatCell
          label="Indexing mode"
          value={details.indexing_policy?.indexingMode || '—'}
          hint={INDEXING_MODE_NOTES[details.indexing_policy?.indexingMode]}
        />
        <StatCell
          label="Consistency"
          value={consistency || 'Account default'}
          hint="Set on the connection. Session is Cosmos's default and the cheapest useful level."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          ok={Boolean(details.indexing_policy?.automatic)}
          label={details.indexing_policy?.automatic ? 'Automatic indexing on' : 'Automatic indexing off'}
          hint={details.indexing_policy?.automatic
            ? 'New fields are indexed as they appear — nothing to maintain, slightly more per write.'
            : 'A new field is NOT indexed until someone adds its path, so filtering on it scans everything.'}
        />
        <StatusPill
          ok={Boolean(details.analytical_store_enabled)}
          label={details.analytical_store_enabled ? 'Analytical store enabled' : 'Analytical store off'}
          hint="A column store kept in sync for analytics, queried by Synapse rather than by this API."
        />
        {details.is_autoscale && <Badge tone="info" size="xs">Autoscale</Badge>}
        {details.last_refreshed && (
          <span className="ml-auto text-[11px] text-subtle">
            Read {fmtDateTime(details.last_refreshed)}
          </span>
        )}
      </div>

      {(docStats || docStatsError) && (
        <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
          {docStatsError ? (
            <div className="sm:col-span-2 xl:col-span-4">
              <Notice tone="warning" className="mb-0" title="Document recency is unavailable.">
                {docStatsError}
              </Notice>
            </div>
          ) : (
            <>
              <StatCell label="Newest document" value={fmtEpochSeconds(docStats.newest_document?._ts) || '—'} />
              <StatCell label="Oldest document" value={fmtEpochSeconds(docStats.oldest_document?._ts) || '—'} />
              <GapTile id="avg_document_size" />
              <GapTile id="largest_document" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── indexing tab ─────────────────────────────────────────────────────────── */

function IndexingTab({ details, ai, target, onExpand, canRun }) {
  const ip = details.indexing_policy || {};
  const uniqueKeys = uniqueKeyPaths(details);

  return (
    <>
      <AiReportPanel
        title="Actmon AI — indexing"
        subtitle={target}
        state={ai}
        onRun={() => ai.mutate()}
        onExpand={onExpand}
        disabled={!canRun}
        runLabel="Analyse indexing"
        only={['checks_performed', 'index_analysis', 'recommended_actions']}
        emptyLabel="Run it for a plain-English read on what this policy does and what it costs."
        pendingLabel="Sampling real documents and reviewing the policy…"
        intro="This reads a real sample of documents from the container, so it can tell you about fields
          that are indexed but always null, or excluded but likely queried — things a policy alone cannot show."
      />

      <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
        <StatCell
          label="Indexing mode"
          value={ip.indexingMode || '—'}
          tone={ip.indexingMode === 'none' ? 'warn' : 'neutral'}
          hint={INDEXING_MODE_NOTES[ip.indexingMode]}
        />
        <StatCell
          label="Automatic"
          value={ip.automatic ? 'On' : 'Off'}
          hint={ip.automatic
            ? 'Every new field is indexed as it appears'
            : 'A new field stays unindexed until its path is added by hand'}
        />
        <StatCell
          label="Unique keys"
          value={uniqueKeys.length}
          hint="Field combinations Cosmos enforces as unique within each partition"
        />
        <StatCell
          label="Index size"
          value={indexSizeOf(details) != null ? fmtBytes(indexSizeOf(details)) : '—'}
          hint="Collection size minus data size"
        />
      </div>

      {ip.indexingMode === 'none' && (
        <Notice tone="warning" title="Indexing is off for this container.">
          Documents can only be fetched by id and partition key. Any query with a WHERE clause will
          either fail or read the whole container. This is a deliberate choice for pure key-value
          workloads — worth confirming it was one.
        </Notice>
      )}

      <div className="grid gap-gutter lg:grid-cols-2">
        {INDEX_SECTIONS.map((section) => {
          const paths = section.pick(ip);
          return (
            <Panel key={section.id} title={section.label} icon={section.icon}>
              <p className="mb-2.5 text-[12px] leading-relaxed text-muted">
                <span className="font-semibold text-success-fg">Buys you: </span>{section.benefit}
                <br />
                <span className="font-semibold text-warning-fg">Costs you: </span>{section.cost}
              </p>
              {paths.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {paths.map((p) => (
                    <span
                      key={p}
                      className="rounded-control border border-border bg-sunken px-2 py-1 font-mono text-[11px] text-fg"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[12px] text-subtle">{section.empty}</p>
              )}
            </Panel>
          );
        })}

        <Panel title="Unique keys" icon="key">
          <p className="mb-2.5 text-[12px] leading-relaxed text-muted">
            <span className="font-semibold text-success-fg">Buys you: </span>
            No two documents in one partition can share these values — duplicates become impossible.
            <br />
            <span className="font-semibold text-warning-fg">Costs you: </span>
            A write that would violate one is rejected, so the application must handle that.
          </p>
          {uniqueKeys.length ? (
            <div className="flex flex-wrap gap-1.5">
              {uniqueKeys.map((k) => (
                <span key={k} className="rounded-control border border-border bg-sunken px-2 py-1 font-mono text-[11px] text-fg">
                  {k}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-subtle">
              None configured. Unique keys can only be set when a container is created, never added later.
            </p>
          )}
        </Panel>
      </div>

      <Panel title="What cannot be measured from here" icon="info">
        <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-4">
          <GapTile id="index_utilization" />
          <GapTile id="ru_savings_estimate" />
          <GapTile id="missing_indexes" />
          <GapTile id="unused_indexes" />
        </div>
      </Panel>
    </>
  );
}

/* ── slow calls ───────────────────────────────────────────────────────────── */

function SlowCallsTab({
  rows, threshold, containers, containerFilter, onContainerFilter,
  minRu, onMinRu, minMs, onMinMs, onExplain, explanations, loading,
}) {
  const filtered = rows.filter((r) => {
    const { container } = parseTarget(r.detail);
    if (containerFilter && container !== containerFilter) return false;
    if (minRu && !(num(r.request_charge) >= Number(minRu))) return false;
    if (minMs && !(num(r.duration_ms) >= Number(minMs))) return false;
    return true;
  });

  const worst = rows.reduce((m, r) => Math.max(m, num(r.duration_ms)), 0);
  const costliest = rows.reduce((m, r) => Math.max(m, num(r.request_charge)), 0);
  const crossPartition = rows.filter((r) => operationMeta(r.operation).crossPartition).length;

  return (
    <div className="space-y-gutter">
      <Notice tone="info" title="These are ActMon's own calls, captured as they happened.">
        Nothing here is synthetic and nothing is a sample of your application's queries — Cosmos does
        not expose those to a monitor. What it does tell you is how this account behaves under the
        kind of read a dashboard makes.
      </Notice>

      <div className="grid grid-cols-2 gap-gutter-sm md:grid-cols-4">
        <MetricTile label="Slow calls" value={rows.length} icon="trend" sub={`over ${fmtNumber(threshold)} ms`} />
        <MetricTile
          label="Slowest"
          value={worst ? `${fmtNumber(worst)} ms` : '—'}
          icon="clock"
          tone={worst > threshold * 10 ? 'bad' : worst ? 'warn' : 'neutral'}
        />
        <MetricTile
          label="Costliest"
          value={costliest ? `${costliest} RU` : '—'}
          icon="zap"
          hint="The highest Request Unit charge among these calls"
        />
        <MetricTile
          label="Cross-partition"
          value={crossPartition}
          icon="layers"
          tone={crossPartition ? 'warn' : 'good'}
          hint="Calls that reach every physical partition — the usual reason a Cosmos read is slow"
        />
      </div>

      <TablePanel
        title="Slow calls"
        icon="trend"
        subtitle="Ordered slowest first by the collector"
        actions={(
          <>
            <Select
              value={containerFilter}
              onChange={onContainerFilter}
              options={[
                { id: '', label: 'All containers' },
                ...containers.map((c) => ({ id: c, label: c })),
              ]}
              size="sm"
              width="auto"
            />
            <Input
              value={minRu}
              onChange={(e) => onMinRu(e.target.value)}
              onClear={() => onMinRu('')}
              type="number"
              placeholder="Min RU"
              size="sm"
              wrapperClassName="w-28"
            />
            <Input
              value={minMs}
              onChange={(e) => onMinMs(e.target.value)}
              onClear={() => onMinMs('')}
              type="number"
              placeholder="Min ms"
              size="sm"
              wrapperClassName="w-28"
            />
            <Badge tone="accent" size="xs">
              {filtered.length === rows.length ? rows.length : `${filtered.length} / ${rows.length}`}
            </Badge>
          </>
        )}
      >
        <Paged rows={filtered} unit="calls">
          {(page, pager) => (
            <>
              <Table
                columns={[
                  { key: 'when', label: 'When' },
                  { key: 'op', label: 'Operation' },
                  { key: 'target', label: 'Target' },
                  { key: 'ms', label: 'Duration', align: 'right' },
                  { key: 'ru', label: 'RU', align: 'right' },
                  {
                    key: 'fanout',
                    label: 'Fan-out',
                    hint: 'Whether the operation necessarily reads every physical partition.',
                  },
                  { key: 'status', label: 'Result' },
                  { key: 'explain', label: '' },
                ]}
                rows={page.map((r) => {
                  const meta = operationMeta(r.operation);
                  const ms = num(r.duration_ms);
                  return {
                    key: String(r.id),
                    cells: {
                      when: (
                        <span className="whitespace-nowrap text-[11px] text-muted">{fmtDateTime(r.created_at)}</span>
                      ),
                      op: meta.hint
                        ? (
                          <Tooltip label={meta.hint} side="top">
                            <span className="text-[12px] font-semibold text-fg">{meta.label}</span>
                          </Tooltip>
                        )
                        : <span className="text-[12px] font-semibold text-fg">{meta.label}</span>,
                      target: (
                        <span className="truncate-safe block max-w-[300px] font-mono text-[11px] text-muted">
                          {r.detail || null}
                        </span>
                      ),
                      ms: (
                        <span className={ms > threshold * 10
                          ? 'font-mono font-bold text-danger-fg' : 'font-mono font-semibold text-warning-fg'}>
                          {fmtNumber(ms)} ms
                        </span>
                      ),
                      ru: r.request_charge != null
                        ? <span className="font-mono text-[12px]">{r.request_charge}</span>
                        : null,
                      fanout: meta.crossPartition
                        ? <Badge tone="warning" size="xs">All partitions</Badge>
                        : meta.crossPartition === false
                          ? <Badge tone="neutral" size="xs">Control plane</Badge>
                          : null,
                      status: r.success
                        ? <Badge tone="success" size="xs"><Icon name="check" size={9} />OK</Badge>
                        : <Badge tone="danger" size="xs"><Icon name="alert" size={9} />Failed</Badge>,
                      explain: (
                        <button
                          type="button"
                          onClick={() => onExplain(r)}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-accent-text transition-opacity hover:opacity-80"
                        >
                          <Icon name="sparkles" size={11} />
                          {explanations[r.id] ? 'View' : 'Explain'}
                        </button>
                      ),
                    },
                  };
                })}
                loading={loading}
                empty={rows.length ? (
                  <EmptyState icon="filter" title="No matches" body="Nothing matches the current filters." />
                ) : (
                  <EmptyState
                    icon="check"
                    title="No slow calls"
                    body={`No logged call took longer than ${fmtNumber(threshold)} ms.`}
                  />
                )}
              />
              {pager}
            </>
          )}
        </Paged>
      </TablePanel>

      <Panel title="What a slow Cosmos call cannot tell you from here" icon="info">
        <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-3">
          <GapTile id="retrieved_vs_returned" />
          <GapTile id="index_utilization" />
        </div>
      </Panel>
    </div>
  );
}

/* ── errors ───────────────────────────────────────────────────────────────── */

function ErrorsTab({ rows, statuses, statusFilter, onStatusFilter, onExplain, explanations, loading }) {
  const filtered = statusFilter
    ? rows.filter((r) => String(r.http_status_code) === statusFilter)
    : rows;

  /* Grouped by status because a Cosmos error's status IS its diagnosis — twelve
     429s and one 403 are two entirely different problems, not thirteen errors. */
  const byStatus = statuses.map((code) => ({
    code,
    meta: statusMeta(code),
    count: rows.filter((r) => r.http_status_code === code).length,
  }));

  return (
    <div className="space-y-gutter">
      <Notice tone="info" title="Every Cosmos SDK exception ActMon hit on this connection.">
        Captured as it happened and stored, never fabricated. A monitor cannot see errors your
        application encountered — those need Azure Monitor or your own logs.
      </Notice>

      {byStatus.length > 0 && (
        <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-3">
          {byStatus.map(({ code, meta, count }) => (
            <button
              key={code}
              type="button"
              onClick={() => onStatusFilter(statusFilter === String(code) ? '' : String(code))}
              aria-pressed={statusFilter === String(code)}
              className={`card px-card py-3 text-left transition-colors hover:border-strong ${
                statusFilter === String(code) ? 'border-accent' : ''
              }`}
            >
              <span className="flex items-center gap-2">
                <Badge tone={meta.tone} size="xs">{code}</Badge>
                <span className="text-[13px] font-bold text-fg">{meta.label}</span>
                <span className="ml-auto font-mono text-[13px] font-bold text-fg tabular-nums">{count}</span>
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-muted">{meta.why}</span>
            </button>
          ))}
        </div>
      )}

      <TablePanel
        title="Errors"
        icon="alert"
        actions={statusFilter && (
          <Button variant="ghost" size="sm" icon="close" onClick={() => onStatusFilter('')}>
            Clear filter
          </Button>
        )}
      >
        <Paged rows={filtered} unit="errors">
          {(page, pager) => (
            <>
              <Table
                columns={[
                  { key: 'when', label: 'When' },
                  { key: 'status', label: 'Status' },
                  { key: 'type', label: 'Exception' },
                  { key: 'op', label: 'Operation' },
                  { key: 'target', label: 'Target' },
                  { key: 'ms', label: 'Duration', align: 'right' },
                  { key: 'message', label: 'Message' },
                  { key: 'explain', label: '' },
                ]}
                rows={page.map((r) => {
                  const meta = statusMeta(r.http_status_code);
                  const { database, container } = parseTarget(r.detail);
                  return {
                    key: String(r.id),
                    cells: {
                      when: (
                        <span className="whitespace-nowrap text-[11px] text-muted">{fmtDateTime(r.created_at)}</span>
                      ),
                      status: meta ? (
                        <Tooltip label={meta.why} side="top">
                          <Badge tone={meta.tone} size="xs">{r.http_status_code} {meta.label}</Badge>
                        </Tooltip>
                      ) : null,
                      type: r.error_type
                        ? <span className="font-mono text-[11px] text-danger-fg">{r.error_type}</span>
                        : null,
                      op: (
                        <span className="text-[12px] font-semibold text-fg">
                          {operationMeta(r.operation).label}
                        </span>
                      ),
                      target: (database || container) ? (
                        <span className="flex flex-col gap-0.5">
                          {container && <span className="font-mono text-[11px] text-fg">{container}</span>}
                          {database && <span className="font-mono text-[10px] text-subtle">{database}</span>}
                        </span>
                      ) : null,
                      ms: r.duration_ms != null
                        ? <span className="font-mono text-[12px] text-muted">{fmtNumber(r.duration_ms)} ms</span>
                        : null,
                      message: (
                        <span
                          title={r.error_message || undefined}
                          className="truncate-safe block max-w-[320px] text-[12px] text-danger-fg"
                        >
                          {r.error_message || null}
                        </span>
                      ),
                      explain: (
                        <button
                          type="button"
                          onClick={() => onExplain(r)}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-accent-text transition-opacity hover:opacity-80"
                        >
                          <Icon name="sparkles" size={11} />
                          {explanations[r.id] ? 'View' : 'Explain'}
                        </button>
                      ),
                    },
                  };
                })}
                loading={loading}
                empty={rows.length ? (
                  <EmptyState icon="filter" title="No matches" body="No error carries that status." />
                ) : (
                  <EmptyState
                    icon="check"
                    title="No errors"
                    body="Every logged call to this account succeeded."
                  />
                )}
              />
              {pager}
            </>
          )}
        </Paged>
      </TablePanel>

      <Panel title="Not available from here" icon="info">
        <div className="grid gap-gutter-sm sm:grid-cols-2 xl:grid-cols-3">
          <GapTile id="retry_count" />
        </div>
      </Panel>
    </div>
  );
}

/* ── document helpers ─────────────────────────────────────────────────────── */

/**
 * A one-line preview of a document, with Cosmos's own `_`-prefixed system fields
 * dropped — a raw `JSON.stringify` spends the whole visible width on `_rid`,
 * `_self`, `_etag` and `_attachments`, which is never what someone is looking for.
 */
export function previewOf(doc) {
  const shown = Object.fromEntries(
    Object.entries(doc).filter(([k]) => !k.startsWith('_') && k !== 'id'),
  );
  const text = JSON.stringify(shown);
  return text === '{}' ? '(no fields beyond id and Cosmos metadata)' : text;
}

/** CSV over a page of documents. Nested values become JSON, not `[object Object]`. */
export function toCsv(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [keys.join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\n');
}

function downloadFile(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
