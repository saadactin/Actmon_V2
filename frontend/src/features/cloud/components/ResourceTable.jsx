import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useResources } from '../hooks/useResources';
import { useAccountDiagnostics } from '../hooks/useCloudAccounts';
import { DiagnosticModal } from './DiagnosticModal';
import CloudFilterBar from './CloudFilterBar';
import Table, { EmptyState } from '@/components/ui/Table';
import { InlineLoading } from '@/components/ui/Loading';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Icon from '@/components/ui/Icon';
import cn from '@/lib/cn';
import {
  Server, HardDrive, SquareFunction, Database, Container, Scale, Inbox,
  Megaphone, Globe, Lock, Shield, User, Bot, Brain, BookOpen, Cloud,
  MapPin, Link2, Unlink, Milestone, Route, Zap, FolderOpen, BarChart3,
  ShieldAlert, Cable, Workflow,
} from 'lucide-react';

// Resource types that represent detachable block storage across providers —
// these are the only ones with a meaningful Attached/Unattached state.
const STORAGE_TYPES = new Set(['BlockVolume', 'ManagedDisk', 'EBSVolume', 'BootVolume']);

// Tone classes mirror Badge's own tone palette, so the icon avatar beside a
// resource's name always matches the tone of its type pill (rendered via <Badge>).
const TONE_CLASSES = {
  info: 'bg-info-soft text-info-fg',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  neutral: 'bg-neutral-soft text-muted',
};

const TYPE_META = {
  EC2Instance: { Icon: Server, tone: 'info' },
  S3Bucket: { Icon: HardDrive, tone: 'accent' },
  LambdaFunction: { Icon: SquareFunction, tone: 'info' },
  DynamoDBTable: { Icon: Database, tone: 'success' },
  RDSInstance: { Icon: Database, tone: 'success' },
  AutonomousDatabase: { Icon: Database, tone: 'success' },
  DbSystem: { Icon: Database, tone: 'success' },
  MySQLDbSystem: { Icon: Database, tone: 'success' },
  NoSQLTable: { Icon: Database, tone: 'success' },
  AuroraCluster: { Icon: Database, tone: 'success' },
  DocumentDBCluster: { Icon: Database, tone: 'success' },
  NeptuneCluster: { Icon: Database, tone: 'success' },
  RedshiftCluster: { Icon: Database, tone: 'success' },
  MySQLServer: { Icon: Database, tone: 'success' },
  PostgreSQLServer: { Icon: Database, tone: 'success' },
  CosmosDB: { Icon: Database, tone: 'success' },
  // Caches, not durable stores — same family as the databases above but a
  // distinct icon so "in-memory, ephemeral" reads differently at a glance.
  ElastiCacheRedis: { Icon: Zap, tone: 'warning' },
  ElastiCacheMemcached: { Icon: Zap, tone: 'warning' },
  RedisCache: { Icon: Zap, tone: 'warning' },
  EKSCluster: { Icon: Container, tone: 'warning' },
  LoadBalancer: { Icon: Scale, tone: 'neutral' },
  SQSQueue: { Icon: Inbox, tone: 'neutral' },
  SNSTopic: { Icon: Megaphone, tone: 'neutral' },
  CloudFront: { Icon: Globe, tone: 'neutral' },
  VPC: { Icon: Lock, tone: 'accent' },
  SecurityGroup: { Icon: Shield, tone: 'neutral' },
  IAMRole: { Icon: User, tone: 'neutral' },
  APIGateway: { Icon: Globe, tone: 'neutral' },
  BedrockModel: { Icon: Bot, tone: 'success' },
  BedrockAgent: { Icon: Brain, tone: 'warning' },
  BedrockKnowledgeBase: { Icon: BookOpen, tone: 'info' },
  BlockVolume: { Icon: HardDrive, tone: 'warning' },
  ManagedDisk: { Icon: HardDrive, tone: 'warning' },
  EBSVolume: { Icon: HardDrive, tone: 'warning' },
  BootVolume: { Icon: HardDrive, tone: 'warning' },
  // OCI's per-VCN objects — Security Lists are a real security boundary
  // (same tone as SecurityGroup/NSG); Route Tables and DHCP Options are
  // network plumbing, not security-relevant, so neutral.
  SecurityList: { Icon: Shield, tone: 'neutral' },
  RouteTable: { Icon: Route, tone: 'neutral' },
  DhcpOptions: { Icon: Milestone, tone: 'neutral' },
  FileSystem: { Icon: FolderOpen, tone: 'accent' },
  AnalyticsInstance: { Icon: BarChart3, tone: 'info' },
  WebAppFirewall: { Icon: ShieldAlert, tone: 'warning' },
  VirtualCircuit: { Icon: Cable, tone: 'accent' },
  DrgAttachment: { Icon: Workflow, tone: 'accent' },
};

function getMeta(type) {
  return TYPE_META[type] || { Icon: Cloud, tone: 'neutral' };
}

function isStopped(status) {
  const s = (status || '').toLowerCase();
  return s.includes('stop') || s.includes('deallocat');
}

// Shared with the row renderer below, so the hide-defaults filter and the
// "default" badge agree on exactly the same definition of "default".
function isDefaultResource(item) {
  return !!item.is_default || item.resource_name.toLowerCase() === 'default' || item.config?.is_default === true;
}

function statusTone(status) {
  const s = (status || '').toLowerCase();
  if (['running', 'active', 'available', 'healthy', 'succeeded'].includes(s)) return 'success';
  if (['pending', 'starting'].includes(s)) return 'warning';
  if (['stopped', 'failed', 'terminated', 'error', 'deleting'].includes(s)) return 'danger';
  return 'neutral';
}

export const ResourceTable = ({ accountId }) => {
  const { data: resources, isLoading } = useResources(accountId);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [attachFilter, setAttachFilter] = useState('All');
  // Provider-created boilerplate (default VPCs/security groups, "default" IAM
  // paths...) shows up in every account and crowds out what someone actually
  // built — checked hides it, unchecked (the default) shows everything as before.
  const [hideDefaults, setHideDefaults] = useState(false);
  const [sortKey, setSortKey] = useState('resource_type');
  const [sortAsc, setSortAsc] = useState(true);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const { data: diagnostics, isLoading: diagnosticsLoading } = useAccountDiagnostics(accountId, showDiagnostic);

  if (!accountId) return null;

  if (isLoading) {
    return <InlineLoading label="Loading resources…" className="py-24" />;
  }

  // Zero resources for the whole account (not just a filtered-down view) —
  // explain why instead of a bare, unexplained empty table.
  if ((resources || []).length === 0) {
    const resourceDiagItems = diagnostics?.resources
      ? [{
        scope: diagnostics.account_name || 'Resources',
        provider: diagnostics.provider,
        category: diagnostics.resources.status,
        message: diagnostics.resources.message
            || (diagnostics.resources.status === 'ok'
              ? `Discovery completed successfully (${diagnostics.resources.resources_found ?? 0} resources found) — if the list still looks empty, try refreshing.`
              : 'No further detail was recorded.'),
      }]
      : [];
    return (
      <div className="card px-6 py-16">
        <EmptyState
          icon="boxes"
          title="No Resources Found"
          body="No resources have been discovered yet for this account."
          action={(
            <Button variant="ghost" size="sm" icon="help" onClick={() => setShowDiagnostic(true)}>
              Why is this empty?
            </Button>
          )}
        />
        {showDiagnostic && (
          <DiagnosticModal
            title="Why are there no resources?"
            items={
              diagnosticsLoading
                ? [{ scope: 'Loading…', category: 'unknown', message: 'Fetching diagnostic information…' }]
                : resourceDiagItems.length > 0
                  ? resourceDiagItems
                  : [{ scope: 'Resources', category: 'unknown', message: 'No diagnostic information could be retrieved for this account.' }]
            }
            onClose={() => setShowDiagnostic(false)}
          />
        )}
      </div>
    );
  }

  const allTypes = ['All', ...Array.from(new Set((resources || []).map((r) => r.resource_type))).sort()];
  const hasStorage = (resources || []).some((r) => STORAGE_TYPES.has(r.resource_type));
  const attachedCount = (resources || []).filter((r) => r.config?.attachment_status === 'Attached').length;
  const unattachedCount = (resources || []).filter((r) => r.config?.attachment_status === 'Unattached').length;
  const defaultCount = (resources || []).filter(isDefaultResource).length;

  const filtered = (resources || [])
    .filter((r) => typeFilter === 'All' || r.resource_type === typeFilter)
    .filter((r) => attachFilter === 'All' || r.config?.attachment_status === attachFilter)
    .filter((r) => !hideDefaults || !isDefaultResource(r))
    .filter((r) => !search || r.resource_name.toLowerCase().includes(search.toLowerCase()) || r.resource_type.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const av = a[sortKey] || '';
      const bv = b[sortKey] || '';
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });

  const toggle = (key) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(true); }
  };

  // Summary chips
  const typeCounts = (resources || []).reduce((acc, r) => {
    acc[r.resource_type] = (acc[r.resource_type] || 0) + 1;
    return acc;
  }, {});

  const hasFilters = search || typeFilter !== 'All' || attachFilter !== 'All' || hideDefaults;
  const clearFilters = () => { setSearch(''); setTypeFilter('All'); setAttachFilter('All'); setHideDefaults(false); };

  const columns = [
    { key: 'name', label: 'Resource Name', sortable: true, sortKey: 'resource_name' },
    { key: 'type', label: 'Type', sortable: true, sortKey: 'resource_type' },
    { key: 'region', label: 'Region', sortable: true, sortKey: 'region_or_zone' },
    { key: 'status', label: 'Status', sortable: true, sortKey: 'status' },
    ...(hasStorage ? [{ key: 'attached', label: 'Attached To' }] : []),
    { key: 'details', label: '', align: 'center', width: 40 },
  ];

  const rows = filtered.map((item) => {
    const isDefault = isDefaultResource(item);
    const meta = getMeta(item.resource_type);
    const tone = isDefault ? 'neutral' : meta.tone;
    const sTone = statusTone(item.status);

    return {
      key: item.id,
      onClick: () => navigate(`/cloud/resources/${item.id}`),
      cells: {
        name: (
          <div className="flex items-center gap-2.5">
            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-control', TONE_CLASSES[tone])}>
              <meta.Icon className="h-4 w-4" />
            </span>
            <span className={cn('font-semibold', isDefault ? 'text-muted' : 'text-fg')}>
              {item.resource_name}
            </span>
            {isDefault && (
              <Badge tone="neutral" size="xs" className="uppercase tracking-wide">default</Badge>
            )}
          </div>
        ),
        type: <Badge tone={tone} size="xs">{item.resource_type}</Badge>,
        region: (
          <span className="inline-flex items-center gap-1 text-muted">
            <MapPin className="h-3.5 w-3.5 text-subtle" />
            {item.region_or_zone}
          </span>
        ),
        status: (
          <Badge tone={sTone} size="xs">
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {(item.status || 'NA').toUpperCase()}
          </Badge>
        ),
        ...(hasStorage ? {
          attached: STORAGE_TYPES.has(item.resource_type) ? (
            item.config?.attachment_status === 'Attached' ? (
              <span className="inline-flex items-center gap-1.5 text-fg">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-accent-text" />
                {item.config?.attached_to_name || item.config?.attached_to_id || 'Unknown'}
                {item.config?.attached_to_status && isStopped(item.config.attached_to_status) && (
                  <Badge tone="danger" size="xs" className="uppercase tracking-wide">stopped</Badge>
                )}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-subtle">
                <Unlink className="h-3.5 w-3.5 shrink-0" />
                Unattached
              </span>
            )
          ) : (
            <span className="text-subtle">—</span>
          ),
        } : {}),
        details: <Icon name="chevron-right" size={16} className="text-subtle" />,
      },
    };
  });

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(typeCounts).map(([type, count]) => {
          const m = getMeta(type);
          const active = typeFilter === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => setTypeFilter(active ? 'All' : type)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors',
                active ? cn('border-transparent', TONE_CLASSES[m.tone]) : 'border-border bg-surface text-muted hover:bg-sunken',
              )}
            >
              <m.Icon className="h-3.5 w-3.5" />
              <span>{type}</span>
              <span className={cn('rounded-full px-1.5 text-[11px] font-bold', active ? 'bg-current/10' : 'bg-sunken text-subtle')}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Attach / detach filter — only relevant when storage resources exist */}
      {hasStorage && (
        <div className="flex flex-wrap gap-2">
          {[
            { key: 'All', label: 'All Storage', Icon: HardDrive, count: attachedCount + unattachedCount },
            { key: 'Attached', label: 'Attached', Icon: Link2, count: attachedCount },
            { key: 'Unattached', label: 'Unattached', Icon: Unlink, count: unattachedCount },
          ].map(({ key, label, Icon: ChipIcon, count }) => {
            const active = attachFilter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setAttachFilter(key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors',
                  active ? cn('border-transparent', TONE_CLASSES.warning) : 'border-border bg-surface text-muted hover:bg-sunken',
                )}
              >
                <ChipIcon className="h-3.5 w-3.5" />
                <span>{label}</span>
                <span className={cn('rounded-full px-1.5 text-[11px] font-bold', active ? 'bg-current/10' : 'bg-sunken text-subtle')}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search bar + display options. CloudFilterBar doesn't accept children
          (it only renders its own search box + `filters` selects), so the
          checkbox is a plain sibling in the same flex-wrap row rather than a
          change to that shared component. */}
      <div className="flex flex-wrap items-center gap-2">
        <CloudFilterBar
          className="flex-1"
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={`Search ${filtered.length} resources…`}
        />
        {defaultCount > 0 && (
          <label className="flex shrink-0 cursor-pointer select-none items-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-xs font-semibold text-muted hover:bg-sunken">
            <input
              type="checkbox"
              checked={hideDefaults}
              onChange={(e) => setHideDefaults(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-[var(--accent)] focus:ring-2 focus:ring-accent"
            />
            Hide default resources
            <span className="rounded-full bg-sunken px-1.5 text-[11px] font-bold text-subtle">{defaultCount}</span>
          </label>
        )}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <Table
          columns={columns}
          rows={rows}
          sort={{ key: sortKey, dir: sortAsc ? 'asc' : 'desc' }}
          onSort={toggle}
          empty={<EmptyState icon="search" title="No resources found" body="Try adjusting your filters." />}
          rowHeight={52}
          virtualize
          virtualizeThreshold={150}
          maxBodyHeight={640}
        />

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border bg-sunken px-4 py-2.5">
          <span className="text-xs text-muted">
            Showing <strong className="font-semibold text-fg">{filtered.length}</strong> of <strong className="font-semibold text-fg">{(resources || []).length}</strong> resources
          </span>
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
