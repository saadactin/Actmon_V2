import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getResourceDetail, getResourceMetrics } from '../api/resources.api';
import { useCloudAccounts } from '../hooks/useCloudAccounts';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import {
  AlertTriangle, Activity, BarChart3, Braces,
  Calendar, ClipboardList, Clock, Cloud, Cpu, Database, DollarSign,
  Globe, HardDrive, Inbox, Info, MapPin, Megaphone, Package,
  Scale, Server, Settings, Boxes, Table2, Tag, Tags, Timer, Zap,
} from 'lucide-react';
import { DiagnosticModal } from '../components/DiagnosticModal';
import { slugForProvider } from '../utils/providerScope';
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

/** Maps a resource/metric status string to the app's fixed status-tone scale. */
function statusTone(status) {
  if (!status) return 'neutral';
  const s = status.toLowerCase();
  if (['running', 'active', 'available'].includes(s)) return 'success';
  if (['pending', 'starting'].includes(s)) return 'warning';
  return 'danger';
}

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
function StatusBadge({ status }) {
  return (
    <Badge tone={statusTone(status)} size="xs" className="uppercase tracking-wide">
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status || 'NA'}
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

/** Empty metrics panel that can explain itself, instead of a dead-end message. */
function MetricsEmpty({ diagnostic, source }) {
  const [open, setOpen] = useState(false);
  return (
    <CloudSection bodyClassName="p-0 flex flex-col items-center justify-center py-16 px-6 text-center">
      <BarChart3 size={40} className="mb-3 text-subtle" />
      <h3 className="text-base font-semibold text-fg">No Metrics Available</h3>
      <p className="mt-1 max-w-md text-sm text-muted">
        No monitoring datapoints were returned for this resource in the last 24 hours.
      </p>
      <button
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-accent-text hover:opacity-80"
      >
        <Info size={14} /> Why are metrics unavailable?
      </button>
      {open && (
        <DiagnosticModal
          title="Why are metrics unavailable?"
          items={[
            diagnostic
              ? { scope: source || 'Monitoring', category: diagnostic.category, message: diagnostic.message }
              : {
                scope: source || 'Monitoring',
                category: 'unknown',
                message:
                    'No diagnostic detail was returned by the backend for this resource. Re-open the tab to retry, '
                    + 'and check the cloud service logs if it keeps happening.',
              },
          ]}
          onClose={() => setOpen(false)}
        />
      )}
    </CloudSection>
  );
}

function MonitoringTabContent({ resourceId }) {
  const { data: metricsData, isLoading, isError } = useQuery({
    queryKey: ['resource-metrics', resourceId],
    queryFn: () => getResourceMetrics(resourceId),
    enabled: !!resourceId,
    staleTime: 5 * 60_000, // refresh every 5 min
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) {
    return <PageLoading title="Fetching metrics…" minHeight={200} />;
  }

  if (isError || !metricsData || !metricsData.metrics) {
    return <MetricsEmpty diagnostic={metricsData?.diagnostic} />;
  }

  const { metrics } = metricsData;
  const isRealtime = metricsData.realtime === true;
  const { source } = metricsData;

  // API returns only real datapoints: series may be empty arrays, or metrics may be {} entirely.
  const metricNames = Object.keys(metrics);
  const hasAnyData = metricNames.some((name) => (metrics[name] || []).length > 0);

  if (metricNames.length === 0 || !hasAnyData) {
    return <MetricsEmpty diagnostic={metricsData.diagnostic} source={source} />;
  }

  // Y-axis / tooltip number formatting — "Execute Count" can run into the
  // millions, which needs abbreviating (1.2M) rather than a wall of zeros.
  const formatCompactNumber = (value) => {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
    return Number.isInteger(value) ? `${value}` : value.toFixed(2);
  };

  return (
    <div className="flex flex-col gap-gutter">
      {/* Data source badge */}
      <div className="flex flex-wrap items-center gap-3">
        {isRealtime && source ? (
          <Badge tone="success" size="xs">
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            Live — {source}
          </Badge>
        ) : (
          <Badge tone="neutral" size="xs">
            <AlertTriangle size={12} />
            No live data — NA
          </Badge>
        )}
        <span className="text-[11px] text-muted">Last 24h</span>
      </div>

      {Object.entries(metrics).map(([metricName, dataPoints]) => {
        if (!dataPoints || dataPoints.length === 0) {
          return (
            <CloudSection key={metricName}>
              <div className="flex items-center justify-between gap-4">
                <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-fg">
                  <Activity size={16} className="text-subtle" />
                  {metricName}
                </h4>
                <span className="text-[11px] font-semibold text-subtle">NA</span>
              </div>
              <p className="mt-2 text-xs text-subtle">No datapoints returned for this metric.</p>
            </CloudSection>
          );
        }

        const chartData = dataPoints.map((dp) => ({
          time: new Date(dp.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          value: dp.value,
        }));

        const seriesMax = Math.max(...chartData.map((d) => d.value));

        // Semantic per-metric-category colouring, drawn from the theme's chart
        // palette (not brand colours) so it follows light/dark and any accent.
        const mn = metricName.toLowerCase();
        let strokeColor = 'var(--chart-1)';
        if (mn.includes('error') || mn.includes('throttle')) {
          strokeColor = 'var(--chart-8)';
        } else if (mn.includes('duration') || mn.includes('latency')) {
          strokeColor = 'var(--chart-7)';
        } else if (mn.includes('memory') || mn.includes('capacity') || mn.includes('count') || mn.includes('object')) {
          strokeColor = 'var(--chart-3)';
        } else if (mn.includes('network') || mn.includes('disk')) {
          strokeColor = 'var(--chart-4)';
        }

        // The gradient id is derived from the metric name (e.g. "CPU Utilization
        // (%)"), which contains spaces/parens — invalid inside a url(#...) fill
        // reference. An unresolvable reference silently falls back to solid
        // black, which is why every chart was rendering as a black wedge.
        const gradientId = `chart-grad-${metricName.replace(/[^a-zA-Z0-9]/g, '-')}`;

        return (
          <CloudSection key={metricName}>
            <div className="mb-3 flex items-center justify-between gap-4">
              <h4 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-fg">
                <Activity size={16} style={{ color: strokeColor }} />
                {metricName}
                <span className="text-[11px] font-normal normal-case tracking-normal text-subtle">(Last 24h)</span>
              </h4>
              <span className="text-[11px] font-semibold text-muted">
                Max: <span className="font-bold text-fg">{formatCompactNumber(seriesMax)}</span>
              </span>
            </div>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={strokeColor} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={strokeColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis
                    dataKey="time"
                    tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                    axisLine={{ stroke: 'var(--chart-grid)' }}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                    tickFormatter={formatCompactNumber}
                  />
                  <Tooltip
                    cursor={{ stroke: strokeColor, strokeWidth: 1, strokeDasharray: '3 3' }}
                    contentStyle={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      boxShadow: 'var(--shadow-md)',
                    }}
                    itemStyle={{ color: 'var(--fg)', fontSize: 12, fontWeight: 600 }}
                    labelStyle={{ color: 'var(--fg-subtle)', fontSize: 11, marginBottom: 2 }}
                    formatter={(value) => [formatCompactNumber(value), metricName]}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={strokeColor}
                    strokeWidth={2}
                    strokeLinecap="round"
                    fillOpacity={1}
                    fill={`url(#${gradientId})`}
                    activeDot={{ r: 4, fill: strokeColor, stroke: 'var(--surface)', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CloudSection>
        );
      })}
    </div>
  );
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

  /* Cost display: only assert a currency symbol/code when the API provides one */
  const costCurrency = resource.cost_currency ?? resource.currency ?? null;
  const costText = resource.cost_monthly != null
    ? `${costCurrency ? `${costCurrency} ` : ''}${Number(resource.cost_monthly).toFixed(2)}`
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
            <span className="font-mono text-[11px] text-subtle break-all">{resource.provider_resource_id}</span>
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
            <StatusBadge status={resource.status} />
            <Badge tone="outline" size="sm">{typeMeta.label}</Badge>
          </div>
        )}
        tabs={(
          <div className="no-scrollbar flex gap-1 overflow-x-auto" role="tablist">
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
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
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
