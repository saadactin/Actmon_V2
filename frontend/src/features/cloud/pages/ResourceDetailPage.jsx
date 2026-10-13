import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getResourceDetail } from '../api/resources.api';
import {
  AlertTriangle, Braces,
  Calendar, ClipboardList, Clock, Cloud, Cpu, Database, DollarSign,
  Globe, HardDrive, Inbox, MapPin, Megaphone, Package,
  Scale, Server, Settings, Boxes, Table2, Tag, Tags, Timer, Zap,
} from 'lucide-react';
import { MonitoringTabContent } from '../components/ResourceMetricsPanel';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { slugForProvider } from '../utils/providerScope';
import { rawStatusTone, statusMeta } from '../utils/resourceModel';
import { exact } from '../utils/costFormat';
import CloudPageHeader from '../components/CloudPageHeader';
import CloudSection from '../components/CloudSection';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/Loading';
import cn from '@/lib/cn';

/* ─── constants ─────────────────────────────────────────────────────── */
const TYPE_META = {
  EC2Instance: { icon: Server, label: 'EC2 Instance' },
  S3Bucket: { icon: Package, label: 'S3 Bucket' },
  LambdaFunction: { icon: Zap, label: 'Lambda Function' },
  DynamoDBTable: { icon: Table2, label: 'DynamoDB Table' },
  RDSInstance: { icon: Database, label: 'RDS Instance' },
  EKSCluster: { icon: Boxes, label: 'EKS Cluster' },
  LoadBalancer: { icon: Scale, label: 'Load Balancer' },
  SQSQueue: { icon: Inbox, label: 'SQS Queue' },
  SNSTopic: { icon: Megaphone, label: 'SNS Topic' },
};

const TABS = ['Overview', 'Monitoring', 'Configuration', 'Metadata', 'Tags', 'Raw JSON'];
// URL slug ↔ tab label — /cloud/resources/:resourceId/:tab (e.g. "raw-json").
const SLUG_FOR_TAB = {
  Overview: 'overview', Monitoring: 'monitoring', Configuration: 'configuration',
  Metadata: 'metadata', Tags: 'tags', 'Raw JSON': 'raw-json',
};
const TAB_FOR_SLUG = Object.fromEntries(Object.entries(SLUG_FOR_TAB).map(([label, slug]) => [slug, label]));

/* ─── helpers ────────────────────────────────────────────────────────── */
function getMeta(type) {
  return TYPE_META[type] || { icon: Cloud, label: type };
}

/**
 * Status tone comes from the shared model, keyed on the NORMALIZED status the
 * backend computed — not from matching provider words here.
 *
 * The version this replaces treated anything it did not recognise as running or
 * pending as a failure, so every Azure resource reporting "Succeeded" (ARM's
 * word for "finished building") rendered red, as did every resource whose state
 * the provider never reported at all. Unknown is not failed, and it is not
 * healthy either; only the backend has the resource type and config needed to
 * tell those apart, so it decides and this renders what it decided.
 */
const statusToneOf = (normalized, raw) => (
  normalized ? statusMeta(normalized).tone : rawStatusTone(raw)
);

function fmt(val) {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'number') return val.toLocaleString();
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function bytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

/* ─── sub-components ────────────────────────────────────────────────── */
function StatusBadge({ status, normalized, reason }) {
  return (
    <Badge
      tone={statusToneOf(normalized, status)}
      size="xs"
      className="uppercase tracking-wide"
      title={reason || (normalized && status ? `Normalized: ${statusMeta(normalized).label}` : undefined)}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {/* The provider's own word where there is one — that is the evidence.
          The tone carries our reading of it, and "Not reported" is said in
          words rather than left as a bare NA. */}
      {status || (normalized ? statusMeta(normalized).label : 'Not reported')}
    </Badge>
  );
}

/** Token-styled card wrapping a titled group of Rows — CloudSection with an icon slot. */
function InfoPanel({ title, icon: TitleIcon, children, bodyClassName = 'p-0' }) {
  return (
    <CloudSection
      title={(
        <span className="flex items-center gap-2">
          {TitleIcon && <TitleIcon size={15} className="text-accent-text" />}
          {title}
        </span>
      )}
      bodyClassName={bodyClassName}
    >
      {children}
    </CloudSection>
  );
}

function Row({ label, value, mono = false, highlight = false, statusValue }) {
  const display = fmt(value);
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-card py-2.5 last:border-b-0">
      <span className="min-w-[140px] shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
      {statusValue !== undefined ? (
        <StatusBadge status={statusValue} />
      ) : (
        <span
          className={cn(
            'max-w-[55%] text-right break-all',
            mono ? 'font-mono text-xs' : 'text-sm',
            highlight ? 'font-semibold text-accent-text' : 'font-medium text-fg',
          )}
        >
          {display}
        </span>
      )}
    </div>
  );
}

function TagPill({ k, v }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-control border border-border bg-sunken px-2 py-0.5 text-xs text-muted">
      <span className="font-semibold text-fg">{k}</span>
      <span className="text-subtle">:</span>
      <span>{v}</span>
    </span>
  );
}

/* ─── Type-specific detail panels ────────────────────────────────────── */
function TypeSpecificPanel({ resource }) {
  const config = resource.config || {};
  const meta = resource.metadata_ || {};
  const type = resource.resource_type;

  if (type === 'DynamoDBTable') {
    return (
      <InfoPanel title="DynamoDB Details" icon={Table2}>
        <Row label="Billing Mode" value={config.billing_mode} highlight />
        <Row label="Item Count" value={config.item_count != null ? config.item_count.toLocaleString() : '—'} />
        <Row label="Table Size" value={config.size_bytes != null ? bytes(config.size_bytes) : '—'} />
        <Row label="Read Capacity" value={config.read_capacity != null ? `${config.read_capacity} RCU` : 'On-Demand'} />
        <Row label="Write Capacity" value={config.write_capacity != null ? `${config.write_capacity} WCU` : 'On-Demand'} />
        <Row label="Creation Date" value={meta.creation_date ? new Date(meta.creation_date).toLocaleString() : '—'} />
        {meta.key_schema && (
          <Row label="Key Schema" value={JSON.stringify(meta.key_schema)} mono />
        )}
      </InfoPanel>
    );
  }

  if (type === 'LambdaFunction') {
    return (
      <InfoPanel title="Lambda Details" icon={Zap}>
        <Row label="Runtime" value={config.runtime} highlight />
        <Row label="Memory" value={config.memory_mb != null ? `${config.memory_mb} MB` : '—'} />
        <Row label="Timeout" value={config.timeout_s != null ? `${config.timeout_s}s` : '—'} />
        <Row label="Last Modified" value={meta.last_modified || '—'} />
        <Row label="Description" value={meta.description || '—'} />
      </InfoPanel>
    );
  }

  if (type === 'S3Bucket') {
    return (
      <InfoPanel title="S3 Bucket Details" icon={Package}>
        <Row label="Creation Date" value={meta.creation_date ? new Date(meta.creation_date).toLocaleString() : '—'} />
        <Row label="Region" value={resource.region_or_zone} highlight />
        <Row label="Identifier" value={resource.provider_resource_id || '—'} mono />
      </InfoPanel>
    );
  }

  if (type === 'EC2Instance') {
    return (
      <InfoPanel title="EC2 Instance Details" icon={Server}>
        <Row label="Instance Type" value={config.instance_type} highlight />
        <Row label="Platform" value={config.platform || '—'} />
        <Row label="Image ID (AMI)" value={config.image_id} mono />
        <Row label="Launch Time" value={meta.launch_time ? new Date(meta.launch_time).toLocaleString() : '—'} />
        <Row label="Private IP" value={resource.ip_address} />
      </InfoPanel>
    );
  }

  if (type === 'RDSInstance') {
    return (
      <InfoPanel title="RDS Instance Details" icon={Database}>
        <Row label="Engine" value={`${config.engine} ${config.engine_version}`} highlight />
        <Row label="Instance Class" value={config.instance_class} />
        <Row label="Storage" value={config.storage_gb != null ? `${config.storage_gb} GB` : '—'} />
        <Row label="Multi-AZ" value={config.multi_az ? 'Yes' : 'No'} />
        <Row label="Endpoint" value={resource.ip_address} mono />
        <Row label="Port" value={meta.port} />
      </InfoPanel>
    );
  }

  if (type === 'EKSCluster') {
    return (
      <InfoPanel title="EKS Cluster Details" icon={Boxes}>
        <Row label="Kubernetes Version" value={config.version} highlight />
        <Row label="Endpoint" value={resource.ip_address} mono />
        <Row label="Created At" value={meta.created_at ? new Date(meta.created_at).toLocaleString() : '—'} />
      </InfoPanel>
    );
  }

  if (type === 'LoadBalancer') {
    return (
      <InfoPanel title="Load Balancer Details" icon={Scale}>
        <Row label="Type" value={config.type} highlight />
        <Row label="Scheme" value={config.scheme} />
        <Row label="DNS Name" value={resource.ip_address} mono />
        <Row label="Created" value={meta.created_time ? new Date(meta.created_time).toLocaleString() : '—'} />
      </InfoPanel>
    );
  }

  // Fallback: show all config keys
  if (Object.keys(config).length > 0) {
    return (
      <InfoPanel title="Configuration Details" icon={Settings}>
        {Object.entries(config).map(([k, v]) => (
          <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} value={v} />
        ))}
      </InfoPanel>
    );
  }

  return null;
}

/* ─── main component ─────────────────────────────────────────────────── */
export const ResourceDetailPage = () => {
  const { resourceId, tab: tabSlug } = useParams();
  const navigate = useNavigate();
  // Tab is URL-driven: /cloud/resources/:resourceId/:tab → every tab has its own route.
  const activeTab = TAB_FOR_SLUG[tabSlug] || 'Overview';
  const setActiveTab = (t) =>
    navigate(`/cloud/resources/${resourceId}${t !== 'Overview' ? `/${SLUG_FOR_TAB[t]}` : ''}`);

  const { data: resource, isLoading, isError } = useQuery({
    queryKey: ['resource-detail', resourceId],
    queryFn: () => getResourceDetail(resourceId),
    enabled: !!resourceId,
    staleTime: 60_000,
  });

  // Back has to be resolved, not hardcoded. This page is reached from six
  // different places (the resource table, the dashboard, topology, cost,
  // security, recommendations), and there is no /cloud/resources route — only
  // /cloud/resources/:id — so a literal backTo="/cloud/resources" landed on the
  // "no page is registered for this route" placeholder. The account's Resources
  // tab is the real parent, so resolve it from the resource's own account.
  const { data: accounts } = useCloudAccounts();
  const owningAccount = (accounts || []).find((a) => a.id === resource?.account_id);
  const parentResourcesRoute = owningAccount
    ? `/cloud/${slugForProvider(owningAccount.provider)}-accounts/${owningAccount.id}/resources`
    : null;
  // Fall back to history when the account list hasn't loaded or the account is
  // gone, so Back always does something sensible instead of 404-ing.
  const goBack = () =>
    parentResourcesRoute ? navigate(parentResourcesRoute) : navigate(-1);

  if (isLoading) {
    return <PageLoading title="Loading resource…" minHeight={320} />;
  }

  if (isError || !resource) {
    return (
      <CloudSection bodyClassName="p-0 flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
        <AlertTriangle size={40} className="text-danger" />
        <h2 className="text-base font-semibold text-fg">Resource not found</h2>
        <p className="text-sm text-muted">The resource you are looking for does not exist or could not be loaded.</p>
        <Button variant="secondary" icon="arrow-left" onClick={() => navigate(-1)} className="mt-2">
          Go Back
        </Button>
      </CloudSection>
    );
  }

  const typeMeta = getMeta(resource.resource_type);
  const TypeIcon = typeMeta.icon;
  const tags = resource.tags || {};
  const config = resource.config || {};
  const metadata_ = resource.metadata_ || {};
  const rawData = resource.raw_data || {};
  const tagCount = Object.keys(tags).length;
  const configCount = Object.keys(config).length;

  /* Cost display: `exact()` returns 'NA' for a missing value and only shows a
     symbol when the API actually told us a currency — same rule every other
     cost figure in this app follows (see utils/costFormat.js). */
  const costCurrency = resource.cost_currency ?? resource.currency ?? null;
  const costText = resource.cost_monthly != null
    ? exact(resource.cost_monthly, costCurrency)
    : null;

  /* Stats depending on type */
  const typeStats = () => {
    const t = resource.resource_type;
    const c = config;
    const m = metadata_;
    if (t === 'DynamoDBTable') {
      return [
        { icon: Package, label: 'Items', value: c.item_count != null ? c.item_count.toLocaleString() : '—' },
        { icon: HardDrive, label: 'Size', value: c.size_bytes != null ? bytes(c.size_bytes) : '—' },
        { icon: Zap, label: 'Billing', value: c.billing_mode ? (c.billing_mode === 'PAY_PER_REQUEST' ? 'On-Demand' : 'Provisioned') : '—' },
      ];
    }
    if (t === 'LambdaFunction') {
      return [
        { icon: Cpu, label: 'Memory', value: c.memory_mb ? `${c.memory_mb} MB` : '—' },
        { icon: Timer, label: 'Timeout', value: c.timeout_s ? `${c.timeout_s}s` : '—' },
        { icon: Settings, label: 'Runtime', value: c.runtime || '—' },
      ];
    }
    if (t === 'EC2Instance') {
      return [
        { icon: Server, label: 'Type', value: c.instance_type || '—' },
        { icon: Globe, label: 'IP', value: resource.ip_address || '—' },
        { icon: HardDrive, label: 'Platform', value: c.platform || '—' },
      ];
    }
    if (t === 'S3Bucket') {
      return [
        { icon: Globe, label: 'Region', value: resource.region_or_zone },
        { icon: Calendar, label: 'Created', value: m.creation_date ? new Date(m.creation_date).toLocaleDateString() : '—' },
      ];
    }
    if (t === 'RDSInstance') {
      return [
        { icon: Settings, label: 'Engine', value: `${c.engine || '—'} ${c.engine_version || ''}` },
        { icon: Tag, label: 'Class', value: c.instance_class || '—' },
        { icon: HardDrive, label: 'Storage', value: c.storage_gb ? `${c.storage_gb} GB` : '—' },
      ];
    }
    return [];
  };

  const extraStats = typeStats();

  const renderTabContent = () => {
    switch (activeTab) {
      case 'Overview':
        return (
          <div className="grid grid-cols-1 gap-gutter lg:grid-cols-2">
            {/* Left column */}
            <div className="flex flex-col gap-gutter">
              <InfoPanel title="Identity" icon={Cloud}>
                <Row label="Resource Name" value={resource.resource_name} highlight />
                <Row label="Resource Type" value={resource.resource_type} />
                <Row label="Provider ID / ARN" value={resource.provider_resource_id} mono />
                <Row label="Region / Zone" value={resource.region_or_zone} />
                <Row label="IP / Endpoint" value={resource.ip_address || '—'} />
                <Row label="Status" value={resource.status} statusValue={resource.status} />
                <Row label="Monthly Cost" value={costText != null ? `${costText}/mo` : 'Not tracked'} />
              </InfoPanel>

              <TypeSpecificPanel resource={resource} />
            </div>

            {/* Right column */}
            <div className="flex flex-col gap-gutter">
              <InfoPanel title="Discovery Info" icon={Clock}>
                <Row label="Discovered At" value={resource.discovered_at ? new Date(resource.discovered_at).toLocaleString() : '—'} />
                <Row label="Resource UUID" value={resource.id} mono />
                <Row label="Account ID" value={resource.account_id} mono />
              </InfoPanel>

              {tagCount > 0 && (
                <InfoPanel title={`Tags (${tagCount})`} icon={Tags} bodyClassName="flex flex-wrap gap-2">
                  {Object.entries(tags).map(([k, v]) => <TagPill key={k} k={k} v={v} />)}
                </InfoPanel>
              )}

              {configCount > 0 && (
                <InfoPanel title="All Config Fields" icon={Settings}>
                  {Object.entries(config).map(([k, v]) => (
                    <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} value={v} />
                  ))}
                </InfoPanel>
              )}
            </div>
          </div>
        );

      case 'Monitoring':
        return <MonitoringTabContent resourceId={resourceId} />;

      case 'Configuration':
        if (configCount === 0) return <Empty icon={Settings} msg="No configuration data available." />;
        return (
          <InfoPanel title="Full Configuration" icon={Settings}>
            {Object.entries(config).map(([k, v]) => (
              <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} value={v} />
            ))}
          </InfoPanel>
        );

      case 'Metadata': {
        const mdKeys = Object.keys(metadata_);
        if (mdKeys.length === 0) return <Empty icon={ClipboardList} msg="No metadata available." />;
        return (
          <InfoPanel title="Metadata" icon={ClipboardList}>
            {Object.entries(metadata_).map(([k, v]) => (
              <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} value={v} />
            ))}
          </InfoPanel>
        );
      }

      case 'Tags':
        if (tagCount === 0) return <Empty icon={Tags} msg="No tags found on this resource." />;
        return (
          <InfoPanel title={`Tags (${tagCount})`} icon={Tags} bodyClassName="flex flex-wrap gap-2">
            {Object.entries(tags).map(([k, v]) => <TagPill key={k} k={k} v={v} />)}
          </InfoPanel>
        );

      case 'Raw JSON': {
        const hasRaw = Object.keys(rawData).length > 0;
        const raw = hasRaw ? rawData : { config, metadata: metadata_, tags };
        return (
          <InfoPanel title="Raw Provider Response" icon={Braces} bodyClassName="p-card">
            {!hasRaw && (
              <p className="mb-3 rounded-control border border-warning-soft bg-warning-soft px-3 py-2 text-xs text-warning-fg">
                No raw provider response stored — showing normalized config.
              </p>
            )}
            <pre className="max-h-[500px] overflow-x-auto rounded-control border border-border bg-sunken p-3 font-mono text-xs leading-relaxed text-fg">
              {JSON.stringify(raw, null, 2)}
            </pre>
          </InfoPanel>
        );
      }
      default:
        return null;
    }
  };

  return (
    <>
      <CloudPageHeader
        title={resource.resource_name}
        description={(
          <span className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <MapPin size={13} className="text-subtle" />
              {resource.region_or_zone || '—'}
            </span>
            {resource.ip_address && (
              <span className="inline-flex items-center gap-1">
                <Globe size={13} className="text-subtle" />
                {resource.ip_address}
              </span>
            )}
            <span className="font-mono text-meta text-subtle break-all">{resource.provider_resource_id}</span>
          </span>
        )}
        leading={(
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
            <TypeIcon size={20} />
          </div>
        )}
        onBack={goBack}
        actions={(
          <div className="flex items-center gap-2">
            <StatusBadge
              status={resource.status}
              normalized={resource.normalized_status}
              reason={resource.status_reason}
            />
            <Badge tone="outline" size="sm">{typeMeta.label}</Badge>
          </div>
        )}
        tabs={(
          <div className="flex flex-wrap gap-x-1" role="tablist">
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                role="tab"
                aria-selected={activeTab === tab}
                className={cn(
                  'relative flex shrink-0 items-center gap-2 whitespace-nowrap px-3 pt-2 pb-2.5 text-[13px] font-semibold transition-colors duration-[var(--dur-fast)]',
                  activeTab === tab ? 'text-accent-text' : 'text-muted hover:text-fg',
                )}
              >
                {tab}
                {activeTab === tab && <span className="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-accent" />}
              </button>
            ))}
          </div>
        )}
      />

      {/* Quick stats row */}
      <div className="mb-gutter flex flex-wrap gap-3">
        {[
          { icon: Clock, label: 'Discovered', value: resource.discovered_at ? new Date(resource.discovered_at).toLocaleDateString() : '—' },
          { icon: Tags, label: 'Tags', value: tagCount.toString() },
          { icon: Settings, label: 'Config Fields', value: configCount.toString() },
          { icon: DollarSign, label: 'Cost/mo', value: costText != null ? costText : 'N/A' },
          ...extraStats,
        ].map((s) => {
          const StatIcon = s.icon;
          return (
            <div key={s.label} className="min-w-[110px] rounded-control border border-border bg-sunken px-4 py-2.5">
              <div className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-muted">
                <StatIcon size={12} className="text-subtle" />
                {s.label}
              </div>
              <div className="mt-0.5 text-sm font-bold text-fg">{s.value}</div>
            </div>
          );
        })}
      </div>

      {/* Content */}
      {renderTabContent()}
    </>
  );
};

function Empty({ icon: Icon, msg }) {
  return (
    <CloudSection bodyClassName="p-0 py-12 px-6 text-center">
      <Icon size={32} className="mx-auto text-subtle" />
      <p className="mt-3 text-sm text-muted">{msg}</p>
    </CloudSection>
  );
}
