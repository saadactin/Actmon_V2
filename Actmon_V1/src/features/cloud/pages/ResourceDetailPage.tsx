import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getResourceDetail, getResourceMetrics } from '../api/resources.api';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import {
  ArrowLeft, Loader2, AlertTriangle, Activity, BarChart3, Braces,
  Calendar, ClipboardList, Clock, Cloud, Cpu, Database, DollarSign,
  Fingerprint, Globe, HardDrive, Inbox, MapPin, Megaphone, Package,
  Scale, Server, Settings, Boxes, Table2, Tag, Tags, Timer, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';


/* ─── constants ─────────────────────────────────────────────────────── */
const TYPE_META: Record<string, { icon: LucideIcon; label: string }> = {
  EC2Instance:    { icon: Server,    label: 'EC2 Instance' },
  S3Bucket:       { icon: Package,   label: 'S3 Bucket' },
  LambdaFunction: { icon: Zap,       label: 'Lambda Function' },
  DynamoDBTable:  { icon: Table2,    label: 'DynamoDB Table' },
  RDSInstance:    { icon: Database,  label: 'RDS Instance' },
  EKSCluster:     { icon: Boxes,     label: 'EKS Cluster' },
  LoadBalancer:   { icon: Scale,     label: 'Load Balancer' },
  SQSQueue:       { icon: Inbox,     label: 'SQS Queue' },
  SNSTopic:       { icon: Megaphone, label: 'SNS Topic' },
};

const TABS = ['Overview', 'Monitoring', 'Configuration', 'Metadata', 'Tags', 'Raw JSON'] as const;
type Tab = typeof TABS[number];


/* ─── helpers ────────────────────────────────────────────────────────── */
function getMeta(type: string) {
  return TYPE_META[type] || { icon: Cloud, label: type };
}

function statusStyle(status?: string | null) {
  const s = (status || '').toLowerCase();
  if (['running', 'active', 'available'].includes(s))
    return { pill: 'bg-green-50 text-green-700 border-green-200', dot: 'bg-green-500' };
  if (['pending', 'starting'].includes(s))
    return { pill: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' };
  return { pill: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' };
}

function fmt(val: any): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'number') return val.toLocaleString();
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function bytes(b: number): string {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

/* ─── sub-components ────────────────────────────────────────────────── */
function InfoPanel({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-200 bg-gray-50">
        <Icon size={16} className="text-blue-600" />
        <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="py-1">{children}</div>
    </div>
  );
}

function Row({ label, value, mono = false, highlight = false, badge }: {
  label: string; value: any; mono?: boolean; highlight?: boolean; badge?: { text: string; pill: string; dot: string };
}) {
  const display = fmt(value);
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5 border-b border-gray-100 last:border-b-0">
      <span className="shrink-0 min-w-[140px] text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</span>
      {badge ? (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${badge.pill}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
          {badge.text}
        </span>
      ) : (
        <span
          className={`max-w-[55%] text-right break-all ${
            mono ? 'font-mono text-xs' : 'text-sm'
          } ${highlight ? 'text-blue-700 font-semibold' : 'text-gray-800 font-medium'}`}
        >
          {display}
        </span>
      )}
    </div>
  );
}

function TagPill({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-md border border-gray-200">
      <span className="font-semibold">{k}</span>
      <span className="text-gray-400">:</span>
      <span>{v}</span>
    </span>
  );
}

/* ─── Type-specific detail panels ────────────────────────────────────── */
function TypeSpecificPanel({ resource }: { resource: any }) {
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
        <Row label="ARN" value={`arn:aws:s3:::${resource.resource_name}`} mono />
      </InfoPanel>
    );
  }

  if (type === 'EC2Instance') {
    return (
      <InfoPanel title="EC2 Instance Details" icon={Server}>
        <Row label="Instance Type" value={config.instance_type} highlight />
        <Row label="Platform" value={config.platform || 'Linux'} />
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
          <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} value={v} />
        ))}
      </InfoPanel>
    );
  }

  return null;
}

function MonitoringTabContent({ resourceId }: { resourceId: string }) {
  const { data: metricsData, isLoading, isError } = useQuery({
    queryKey: ['resource-metrics', resourceId],
    queryFn: () => getResourceMetrics(resourceId),
    enabled: !!resourceId,
    staleTime: 5 * 60_000,        // refresh every 5 min
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 min-h-[200px]">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        <span className="text-sm text-gray-500">Fetching CloudWatch metrics…</span>
      </div>
    );
  }

  if (isError || !metricsData || !metricsData.metrics) {
    return <Empty icon={BarChart3} msg="No metrics available for this resource." />;
  }

  const metrics    = metricsData.metrics;
  const isRealtime = metricsData.realtime === true;

  // Check if all series are completely flat-zero (no live CW data)
  const allZero = Object.values(metrics).every((series: any) =>
    series.every((dp: any) => dp.value === 0)
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Data source badge */}
      <div className="flex items-center gap-3 flex-wrap">
        {isRealtime && !allZero ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border bg-green-50 text-green-700 border-green-200">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
            Live — AWS CloudWatch
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border bg-gray-100 text-gray-600 border-gray-200">
            <AlertTriangle size={12} className="text-gray-400" />
            No CloudWatch data — showing zero baseline
          </span>
        )}
        <span className="text-[11px] text-gray-500">Last 24h · Hourly resolution</span>
      </div>

      {Object.entries(metrics).map(([metricName, dataPoints]: [string, any]) => {
        const chartData = dataPoints.map((dp: any) => ({
          time: new Date(dp.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          value: dp.value,
        }));

        const seriesMax = Math.max(...chartData.map((d: any) => d.value));
        const hasData   = seriesMax > 0;

        const mn = metricName.toLowerCase();
        let strokeColor = '#2563eb';
        if (mn.includes('error') || mn.includes('throttle')) {
          strokeColor = '#ef4444';
        } else if (mn.includes('duration') || mn.includes('latency')) {
          strokeColor = '#8b5cf6';
        } else if (mn.includes('memory') || mn.includes('capacity') || mn.includes('count') || mn.includes('object')) {
          strokeColor = '#0d9488';
        } else if (mn.includes('network') || mn.includes('disk')) {
          strokeColor = '#f59e0b';
        }

        return (
          <div key={metricName} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center justify-between gap-4 mb-3">
              <h4 className="flex items-center gap-2 text-sm font-bold text-gray-700 uppercase tracking-wider">
                <Activity size={16} className="text-blue-600" />
                {metricName}
                <span className="text-[11px] font-normal normal-case tracking-normal text-gray-400">(Last 24h)</span>
              </h4>
              {hasData ? (
                <span className="text-[11px] font-semibold text-green-600">
                  Max: {seriesMax.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              ) : (
                <span className="text-[11px] text-gray-400">No data</span>
              )}
            </div>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                  <defs>
                    <linearGradient id={`color-${metricName}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={hasData ? strokeColor : '#9ca3af'} stopOpacity={hasData ? 0.2 : 0.05}/>
                      <stop offset="95%" stopColor={hasData ? strokeColor : '#9ca3af'} stopOpacity={0.01}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                  <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
                  <YAxis tick={{ fill: '#6b7280', fontSize: 12 }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8 }}
                    itemStyle={{ color: '#374151', fontSize: 12 }}
                    labelStyle={{ color: '#6b7280', fontSize: 11 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={hasData ? strokeColor : '#9ca3af'}
                    strokeWidth={hasData ? 2 : 1}
                    fillOpacity={1}
                    fill={`url(#color-${metricName})`}
                    strokeDasharray={hasData ? undefined : '4,4'}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── main component ─────────────────────────────────────────────────── */
export const ResourceDetailPage: React.FC = () => {

  const { resourceId } = useParams<{ resourceId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('Overview');

  const { data: resource, isLoading, isError } = useQuery({
    queryKey: ['resource-detail', resourceId],
    queryFn: () => getResourceDetail(resourceId!),
    enabled: !!resourceId,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex flex-col items-center justify-center gap-3 py-24">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          <span className="text-sm text-gray-500">Loading resource…</span>
        </div>
      </div>
    );
  }

  if (isError || !resource) {
    return (
      <div className="p-6">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm flex flex-col items-center justify-center gap-3 py-12 px-6 text-center">
          <AlertTriangle size={40} className="text-red-500" />
          <h2 className="text-base font-semibold text-gray-900">Resource not found</h2>
          <p className="text-sm text-gray-500">The resource you are looking for does not exist or could not be loaded.</p>
          <button
            onClick={() => navigate(-1)}
            className="mt-2 inline-flex items-center gap-1.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
          >
            <ArrowLeft size={16} />
            Go Back
          </button>
        </div>
      </div>
    );
  }

  const typeMeta = getMeta(resource.resource_type);
  const TypeIcon = typeMeta.icon;
  const sc = statusStyle(resource.status);
  const tags = (resource.tags as Record<string, string> | null) || {};
  const config = (resource.config as Record<string, any> | null) || {};
  const metadata_ = ((resource as any).metadata_ as Record<string, any> | null) || {};
  const rawData = ((resource as any).raw_data as Record<string, any> | null) || {};
  const tagCount = Object.keys(tags).length;
  const configCount = Object.keys(config).length;

  /* Stats depending on type */
  const typeStats = (): { icon: LucideIcon; label: string; value: string }[] => {
    const t = resource.resource_type;
    const c = config;
    const m = metadata_;
    if (t === 'DynamoDBTable') return [
      { icon: Package,   label: 'Items',   value: c.item_count != null ? c.item_count.toLocaleString() : '0' },
      { icon: HardDrive, label: 'Size',    value: c.size_bytes != null ? bytes(c.size_bytes) : '0 B' },
      { icon: Zap,       label: 'Billing', value: c.billing_mode === 'PAY_PER_REQUEST' ? 'On-Demand' : 'Provisioned' },
    ];
    if (t === 'LambdaFunction') return [
      { icon: Cpu,      label: 'Memory',  value: c.memory_mb ? `${c.memory_mb} MB` : '—' },
      { icon: Timer,    label: 'Timeout', value: c.timeout_s ? `${c.timeout_s}s` : '—' },
      { icon: Settings, label: 'Runtime', value: c.runtime || '—' },
    ];
    if (t === 'EC2Instance') return [
      { icon: Server,    label: 'Type',     value: c.instance_type || '—' },
      { icon: Globe,     label: 'IP',       value: resource.ip_address || '—' },
      { icon: HardDrive, label: 'Platform', value: c.platform || 'Linux' },
    ];
    if (t === 'S3Bucket') return [
      { icon: Globe,    label: 'Region',  value: resource.region_or_zone },
      { icon: Calendar, label: 'Created', value: m.creation_date ? new Date(m.creation_date).toLocaleDateString() : '—' },
    ];
    if (t === 'RDSInstance') return [
      { icon: Settings,  label: 'Engine',  value: `${c.engine || '—'} ${c.engine_version || ''}` },
      { icon: Tag,       label: 'Class',   value: c.instance_class || '—' },
      { icon: HardDrive, label: 'Storage', value: c.storage_gb ? `${c.storage_gb} GB` : '—' },
    ];
    return [];
  };

  const extraStats = typeStats();

  const renderTabContent = () => {
    switch (activeTab) {
      case 'Overview':
        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left column */}
            <div className="flex flex-col gap-4">
              <InfoPanel title="Identity" icon={Fingerprint}>
                <Row label="Resource Name" value={resource.resource_name} highlight />
                <Row label="Resource Type" value={resource.resource_type} />
                <Row label="Provider ID / ARN" value={resource.provider_resource_id} mono />
                <Row label="Region / Zone" value={resource.region_or_zone} />
                <Row label="IP / Endpoint" value={resource.ip_address || '—'} />
                <Row label="Status" value={resource.status}
                  badge={{ text: (resource.status || 'UNKNOWN').toUpperCase(), pill: sc.pill, dot: sc.dot }} />
                <Row label="Monthly Cost" value={
                  resource.cost_monthly != null ? `$${Number(resource.cost_monthly).toFixed(2)}/mo` : 'Not tracked'
                } />
              </InfoPanel>

              <TypeSpecificPanel resource={resource} />
            </div>

            {/* Right column */}
            <div className="flex flex-col gap-4">
              <InfoPanel title="Discovery Info" icon={Clock}>
                <Row label="Discovered At" value={resource.discovered_at ? new Date(resource.discovered_at).toLocaleString() : '—'} />
                <Row label="Resource UUID" value={resource.id} mono />
                <Row label="Account ID" value={resource.account_id} mono />
              </InfoPanel>

              {tagCount > 0 && (
                <InfoPanel title={`Tags (${tagCount})`} icon={Tags}>
                  <div className="px-5 py-4 flex flex-wrap gap-2">
                    {Object.entries(tags).map(([k, v]) => <TagPill key={k} k={k} v={v} />)}
                  </div>
                </InfoPanel>
              )}

              {configCount > 0 && (
                <InfoPanel title="All Config Fields" icon={Settings}>
                  {Object.entries(config).map(([k, v]) => (
                    <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} value={v} />
                  ))}
                </InfoPanel>
              )}
            </div>
          </div>
        );

      case 'Monitoring':
        return <MonitoringTabContent resourceId={resourceId!} />;

      case 'Configuration':
        if (configCount === 0) return <Empty icon={Settings} msg="No configuration data available." />;
        return (
          <InfoPanel title="Full Configuration" icon={Settings}>
            {Object.entries(config).map(([k, v]) => (
              <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} value={v} />
            ))}
          </InfoPanel>
        );

      case 'Metadata':
        const mdKeys = Object.keys(metadata_);
        if (mdKeys.length === 0) return <Empty icon={ClipboardList} msg="No metadata available." />;
        return (
          <InfoPanel title="Metadata" icon={ClipboardList}>
            {Object.entries(metadata_).map(([k, v]) => (
              <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} value={v} />
            ))}
          </InfoPanel>
        );

      case 'Tags':
        if (tagCount === 0) return <Empty icon={Tags} msg="No tags found on this resource." />;
        return (
          <InfoPanel title={`Tags (${tagCount})`} icon={Tags}>
            <div className="px-5 py-4 flex flex-wrap gap-2">
              {Object.entries(tags).map(([k, v]) => <TagPill key={k} k={k} v={v} />)}
            </div>
          </InfoPanel>
        );

      case 'Raw JSON':
        const raw = Object.keys(rawData).length ? rawData : { config, metadata: metadata_, tags };
        return (
          <InfoPanel title="Raw AWS Response Data" icon={Braces}>
            <div className="p-4">
              <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs font-mono text-gray-700 overflow-x-auto max-h-[500px] leading-relaxed">
                {JSON.stringify(raw, null, 2)}
              </pre>
            </div>
          </InfoPanel>
        );
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Back */}
      <button
        onClick={() => navigate('/cloud/resources')}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors"
      >
        <ArrowLeft size={16} />
        Back to Resources
      </button>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-start gap-4">
          {/* Icon */}
          <div className="h-14 w-14 shrink-0 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
            <TypeIcon size={28} className="text-blue-600" />
          </div>

          {/* Title */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap mb-1.5">
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
                {resource.resource_name}
              </h1>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border uppercase tracking-wide ${sc.pill}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} />
                {resource.status || 'UNKNOWN'}
              </span>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold border bg-blue-50 text-blue-700 border-blue-200">
                {typeMeta.label}
              </span>
            </div>
            <div className="flex items-center gap-4 flex-wrap text-sm text-gray-500">
              <span className="inline-flex items-center gap-1">
                <MapPin size={14} className="text-gray-400" />
                {resource.region_or_zone}
              </span>
              {resource.ip_address && (
                <span className="inline-flex items-center gap-1">
                  <Globe size={14} className="text-gray-400" />
                  {resource.ip_address}
                </span>
              )}
            </div>
            <p className="mt-2 font-mono text-xs text-gray-400 break-all">
              {resource.provider_resource_id}
            </p>
          </div>
        </div>

        {/* Stat row */}
        <div className="flex flex-wrap gap-3 mt-5 pt-5 border-t border-gray-100">
          {[
            { icon: Clock as LucideIcon, label: 'Discovered', value: resource.discovered_at ? new Date(resource.discovered_at).toLocaleDateString() : '—' },
            { icon: Tags as LucideIcon, label: 'Tags', value: tagCount.toString() },
            { icon: Settings as LucideIcon, label: 'Config Fields', value: configCount.toString() },
            { icon: DollarSign as LucideIcon, label: 'Cost/mo', value: resource.cost_monthly != null ? `$${Number(resource.cost_monthly).toFixed(2)}` : 'N/A' },
            ...extraStats,
          ].map(s => {
            const StatIcon = s.icon;
            return (
              <div key={s.label} className="min-w-[110px] rounded-lg bg-gray-50 border border-gray-200 px-4 py-2.5">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                  <StatIcon size={12} className="text-gray-400" />
                  {s.label}
                </div>
                <div className="mt-0.5 text-sm font-bold text-gray-800">{s.value}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-white border border-gray-200 rounded-xl shadow-sm p-1 overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 whitespace-nowrap px-3.5 py-2 rounded-lg text-sm transition-colors ${
              activeTab === tab
                ? 'bg-blue-50 text-blue-700 font-semibold'
                : 'text-gray-500 font-medium hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ── Content ──────────────────────────────────────────────────── */}
      {renderTabContent()}
    </div>
  );
};

function Empty({ icon: Icon, msg }: { icon: LucideIcon; msg: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm text-center py-12 px-6">
      <Icon size={32} className="mx-auto text-gray-300" />
      <p className="mt-3 text-sm text-gray-500">{msg}</p>
    </div>
  );
}
