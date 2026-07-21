import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getResourceDetail, getResourceMetrics } from '../api/resources.api';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';


/* ─── constants ─────────────────────────────────────────────────────── */
const TYPE_META: Record<string, { icon: string; color: string; label: string }> = {
  EC2Instance:    { icon: '🖥️', color: '#f59e0b', label: 'EC2 Instance' },
  S3Bucket:       { icon: '🪣', color: '#3b82f6', label: 'S3 Bucket' },
  LambdaFunction: { icon: 'λ',  color: '#a855f7', label: 'Lambda Function' },
  DynamoDBTable:  { icon: '🗄️', color: '#10b981', label: 'DynamoDB Table' },
  RDSInstance:    { icon: '💾', color: '#06b6d4', label: 'RDS Instance' },
  EKSCluster:     { icon: '⚓', color: '#6366f1', label: 'EKS Cluster' },
  LoadBalancer:   { icon: '⚖️', color: '#ec4899', label: 'Load Balancer' },
  SQSQueue:       { icon: '📬', color: '#f97316', label: 'SQS Queue' },
  SNSTopic:       { icon: '📢', color: '#eab308', label: 'SNS Topic' },
};

const TABS = ['Overview', 'Monitoring', 'Configuration', 'Metadata', 'Tags', 'Raw JSON'] as const;
type Tab = typeof TABS[number];


/* ─── helpers ────────────────────────────────────────────────────────── */
function getMeta(type: string) {
  return TYPE_META[type] || { icon: '☁️', color: '#94a3b8', label: type };
}

function statusStyle(status?: string | null) {
  const s = (status || '').toLowerCase();
  if (['running', 'active', 'available'].includes(s))
    return { bg: 'rgba(34,197,94,0.15)', fg: '#4ade80', dot: '#22c55e' };
  if (['pending', 'starting'].includes(s))
    return { bg: 'rgba(234,179,8,0.15)', fg: '#facc15', dot: '#eab308' };
  return { bg: 'rgba(239,68,68,0.15)', fg: '#f87171', dot: '#ef4444' };
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
function StatCard({ icon, label, value, sub, color = '#60a5fa' }: {
  icon: string; label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div style={{
      background: '#f8fafc',
      border: `1px solid ${color}22`,
      borderRadius: 14,
      padding: '18px 20px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ fontSize: 20 }}>{icon}</div>
      <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8 }}>{label}</div>
      <div style={{ color: '#1e293b', fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ color: '#64748b', fontSize: 11 }}>{sub}</div>}
    </div>
  );
}

function InfoPanel({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 14,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '14px 20px',
        borderBottom: '1px solid #e2e8f0',
        display: 'flex', alignItems: 'center', gap: 8,
        background: '#f1f5f9',
      }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ color: '#475569', fontSize: 14, fontWeight: 700 }}>{title}</span>
      </div>
      <div style={{ padding: '4px 0' }}>{children}</div>
    </div>
  );
}

function Row({ label, value, mono = false, highlight = false, badge }: {
  label: string; value: any; mono?: boolean; highlight?: boolean; badge?: { text: string; color: string };
}) {
  const display = fmt(value);
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '11px 20px',
      borderBottom: '1px solid #e2e8f0',
      gap: 16,
    }}>
      <span style={{ color: '#64748b', fontSize: 13, flexShrink: 0, minWidth: 160 }}>{label}</span>
      {badge ? (
        <span style={{
          background: `${badge.color}20`, border: `1px solid ${badge.color}44`,
          color: badge.color, fontSize: 12, fontWeight: 700,
          padding: '2px 10px', borderRadius: 20,
        }}>{badge.text}</span>
      ) : (
        <span style={{
          color: highlight ? '#60a5fa' : '#e2e8f0',
          fontSize: 13,
          fontFamily: mono ? 'monospace' : 'inherit',
          textAlign: 'right',
          wordBreak: 'break-all',
          maxWidth: '55%',
          fontWeight: highlight ? 600 : 400,
        }}>{display}</span>
      )}
    </div>
  );
}

function TagPill({ k, v }: { k: string; v: string }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.2)',
      borderRadius: 8, padding: '5px 12px', margin: 3,
    }}>
      <span style={{ color: '#93c5fd', fontSize: 12, fontWeight: 700 }}>{k}</span>
      <span style={{ color: '#64748b', fontSize: 11 }}>:</span>
      <span style={{ color: '#334155', fontSize: 12 }}>{v}</span>
    </div>
  );
}

/* ─── Type-specific detail panels ────────────────────────────────────── */
function TypeSpecificPanel({ resource }: { resource: any }) {
  const config = resource.config || {};
  const meta = resource.metadata_ || {};
  const type = resource.resource_type;

  if (type === 'DynamoDBTable') {
    return (
      <InfoPanel title="DynamoDB Details" icon="🗄️">
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
      <InfoPanel title="Lambda Details" icon="λ">
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
      <InfoPanel title="S3 Bucket Details" icon="🪣">
        <Row label="Creation Date" value={meta.creation_date ? new Date(meta.creation_date).toLocaleString() : '—'} />
        <Row label="Region" value={resource.region_or_zone} highlight />
        <Row label="ARN" value={`arn:aws:s3:::${resource.resource_name}`} mono />
      </InfoPanel>
    );
  }

  if (type === 'EC2Instance') {
    return (
      <InfoPanel title="EC2 Instance Details" icon="🖥️">
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
      <InfoPanel title="RDS Instance Details" icon="💾">
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
      <InfoPanel title="EKS Cluster Details" icon="⚓">
        <Row label="Kubernetes Version" value={config.version} highlight />
        <Row label="Endpoint" value={resource.ip_address} mono />
        <Row label="Created At" value={meta.created_at ? new Date(meta.created_at).toLocaleString() : '—'} />
      </InfoPanel>
    );
  }

  if (type === 'LoadBalancer') {
    return (
      <InfoPanel title="Load Balancer Details" icon="⚖️">
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
      <InfoPanel title="Configuration Details" icon="⚙️">
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200, flexDirection: 'column', gap: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: '50%', border: '2px solid rgba(96,165,250,0.2)', borderTopColor: '#60a5fa', animation: 'spin 0.9s linear infinite' }} />
        <span style={{ color: '#94a3b8', fontSize: 13 }}>Fetching CloudWatch metrics…</span>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (isError || !metricsData || !metricsData.metrics) {
    return <Empty icon="📊" msg="No metrics available for this resource." />;
  }

  const metrics    = metricsData.metrics;
  const isRealtime = metricsData.realtime === true;

  // Check if all series are completely flat-zero (no live CW data)
  const allZero = Object.values(metrics).every((series: any) =>
    series.every((dp: any) => dp.value === 0)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Data source badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {isRealtime && !allZero ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 12px', borderRadius: 20,
            background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)',
            color: '#10b981', fontSize: 11, fontWeight: 700,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse 1.5s ease-in-out infinite' }} />
            Live — AWS CloudWatch
          </span>
        ) : (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 12px', borderRadius: 20,
            background: 'rgba(100,116,139,0.12)', border: '1px solid rgba(100,116,139,0.25)',
            color: '#94a3b8', fontSize: 11, fontWeight: 600,
          }}>
            ⚠ No CloudWatch data — showing zero baseline
          </span>
        )}
        <span style={{ color: '#475569', fontSize: 11 }}>Last 24h · Hourly resolution</span>
        <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
      </div>

      {Object.entries(metrics).map(([metricName, dataPoints]: [string, any]) => {
        const chartData = dataPoints.map((dp: any) => ({
          time: new Date(dp.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          value: dp.value,
        }));

        const seriesMax = Math.max(...chartData.map((d: any) => d.value));
        const hasData   = seriesMax > 0;

        let strokeColor = '#3b82f6';
        if (metricName.toLowerCase().includes('error') || metricName.toLowerCase().includes('throttle')) {
          strokeColor = '#ef4444';
        } else if (metricName.toLowerCase().includes('duration') || metricName.toLowerCase().includes('latency')) {
          strokeColor = '#a855f7';
        } else if (metricName.toLowerCase().includes('capacity') || metricName.toLowerCase().includes('count') || metricName.toLowerCase().includes('object')) {
          strokeColor = '#10b981';
        } else if (metricName.toLowerCase().includes('network') || metricName.toLowerCase().includes('memory')) {
          strokeColor = '#06b6d4';
        }

        return (
          <div key={metricName} style={{
            background: '#f8fafc',
            border: `1px solid ${hasData ? '#e2e8f0' : 'rgba(100,116,139,0.12)'}`,
            borderRadius: 14,
            padding: '18px 22px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: hasData ? '#cbd5e1' : '#475569' }}>
                📊 {metricName} <span style={{ color: '#475569', fontWeight: 400, fontSize: 11 }}>(Last 24h)</span>
              </h4>
              {hasData ? (
                <span style={{ fontSize: 11, color: '#10b981', fontWeight: 700 }}>
                  Max: {seriesMax.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: '#475569' }}>No data</span>
              )}
            </div>
            <div style={{ height: 160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                  <defs>
                    <linearGradient id={`color-${metricName}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={hasData ? strokeColor : '#475569'} stopOpacity={hasData ? 0.25 : 0.05}/>
                      <stop offset="95%" stopColor={hasData ? strokeColor : '#475569'} stopOpacity={0.01}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" vertical={false} />
                  <XAxis dataKey="time" stroke="#64748b" fontSize={9} tickLine={false} />
                  <YAxis stroke="#64748b" fontSize={9} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8 }}
                    itemStyle={{ color: '#475569', fontSize: 11 }}
                    labelStyle={{ color: '#64748b', fontSize: 10 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={hasData ? strokeColor : '#334155'}
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
      <div style={{ ...PAGE, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', border: '3px solid rgba(96,165,250,0.2)', borderTopColor: '#60a5fa', animation: 'spin 0.9s linear infinite' }} />
        <span style={{ color: '#94a3b8' }}>Loading resource…</span>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (isError || !resource) {
    return (
      <div style={{ ...PAGE, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 48 }}>⚠️</span>
        <span style={{ color: '#f87171', fontSize: 16, fontWeight: 600 }}>Resource not found</span>
        <button onClick={() => navigate(-1)} style={BACK_BTN}>← Go Back</button>
      </div>
    );
  }

  const typeMeta = getMeta(resource.resource_type);
  const sc = statusStyle(resource.status);
  const tags = (resource.tags as Record<string, string> | null) || {};
  const config = (resource.config as Record<string, any> | null) || {};
  const metadata_ = ((resource as any).metadata_ as Record<string, any> | null) || {};
  const rawData = ((resource as any).raw_data as Record<string, any> | null) || {};
  const tagCount = Object.keys(tags).length;
  const configCount = Object.keys(config).length;

  /* Stats depending on type */
  const typeStats = () => {
    const t = resource.resource_type;
    const c = config;
    const m = metadata_;
    if (t === 'DynamoDBTable') return [
      { icon: '📦', label: 'Items', value: c.item_count != null ? c.item_count.toLocaleString() : '0', color: '#10b981' },
      { icon: '💽', label: 'Size', value: c.size_bytes != null ? bytes(c.size_bytes) : '0 B', color: '#10b981' },
      { icon: '⚡', label: 'Billing', value: c.billing_mode === 'PAY_PER_REQUEST' ? 'On-Demand' : 'Provisioned', color: '#10b981' },
    ];
    if (t === 'LambdaFunction') return [
      { icon: '🧠', label: 'Memory', value: c.memory_mb ? `${c.memory_mb} MB` : '—', color: '#a855f7' },
      { icon: '⏱️', label: 'Timeout', value: c.timeout_s ? `${c.timeout_s}s` : '—', color: '#a855f7' },
      { icon: '⚙️', label: 'Runtime', value: c.runtime || '—', color: '#a855f7' },
    ];
    if (t === 'EC2Instance') return [
      { icon: '🖥️', label: 'Type', value: c.instance_type || '—', color: '#f59e0b' },
      { icon: '🌐', label: 'IP', value: resource.ip_address || '—', color: '#f59e0b' },
      { icon: '💿', label: 'Platform', value: c.platform || 'Linux', color: '#f59e0b' },
    ];
    if (t === 'S3Bucket') return [
      { icon: '🌍', label: 'Region', value: resource.region_or_zone, color: '#3b82f6' },
      { icon: '📅', label: 'Created', value: m.creation_date ? new Date(m.creation_date).toLocaleDateString() : '—', color: '#3b82f6' },
    ];
    if (t === 'RDSInstance') return [
      { icon: '⚙️', label: 'Engine', value: `${c.engine || '—'} ${c.engine_version || ''}`, color: '#06b6d4' },
      { icon: '🏷️', label: 'Class', value: c.instance_class || '—', color: '#06b6d4' },
      { icon: '💽', label: 'Storage', value: c.storage_gb ? `${c.storage_gb} GB` : '—', color: '#06b6d4' },
    ];
    return [];
  };

  const extraStats = typeStats();

  const renderTabContent = () => {
    switch (activeTab) {
      case 'Overview':
        return (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Left column */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <InfoPanel title="Identity" icon="🔍">
                <Row label="Resource Name" value={resource.resource_name} highlight />
                <Row label="Resource Type" value={resource.resource_type} />
                <Row label="Provider ID / ARN" value={resource.provider_resource_id} mono />
                <Row label="Region / Zone" value={resource.region_or_zone} />
                <Row label="IP / Endpoint" value={resource.ip_address || '—'} />
                <Row label="Status" value={resource.status}
                  badge={{ text: (resource.status || 'UNKNOWN').toUpperCase(), color: sc.dot }} />
                <Row label="Monthly Cost" value={
                  resource.cost_monthly != null ? `$${Number(resource.cost_monthly).toFixed(2)}/mo` : 'Not tracked'
                } />
              </InfoPanel>

              <TypeSpecificPanel resource={resource} />
            </div>

            {/* Right column */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <InfoPanel title="Discovery Info" icon="🕐">
                <Row label="Discovered At" value={resource.discovered_at ? new Date(resource.discovered_at).toLocaleString() : '—'} />
                <Row label="Resource UUID" value={resource.id} mono />
                <Row label="Account ID" value={resource.account_id} mono />
              </InfoPanel>

              {tagCount > 0 && (
                <InfoPanel title={`Tags (${tagCount})`} icon="🏷️">
                  <div style={{ padding: '12px 16px', display: 'flex', flexWrap: 'wrap' }}>
                    {Object.entries(tags).map(([k, v]) => <TagPill key={k} k={k} v={v} />)}
                  </div>
                </InfoPanel>
              )}

              {configCount > 0 && (
                <InfoPanel title="All Config Fields" icon="⚙️">
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
        if (configCount === 0) return <Empty icon="⚙️" msg="No configuration data available." />;
        return (
          <InfoPanel title="Full Configuration" icon="⚙️">
            {Object.entries(config).map(([k, v]) => (
              <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} value={v} />
            ))}
          </InfoPanel>
        );

      case 'Metadata':
        const mdKeys = Object.keys(metadata_);
        if (mdKeys.length === 0) return <Empty icon="📋" msg="No metadata available." />;
        return (
          <InfoPanel title="Metadata" icon="📋">
            {Object.entries(metadata_).map(([k, v]) => (
              <Row key={k} label={k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} value={v} />
            ))}
          </InfoPanel>
        );

      case 'Tags':
        if (tagCount === 0) return <Empty icon="🏷️" msg="No tags found on this resource." />;
        return (
          <InfoPanel title={`Tags (${tagCount})`} icon="🏷️">
            <div style={{ padding: '16px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {Object.entries(tags).map(([k, v]) => <TagPill key={k} k={k} v={v} />)}
            </div>
          </InfoPanel>
        );

      case 'Raw JSON':
        const raw = Object.keys(rawData).length ? rawData : { config, metadata: metadata_, tags };
        return (
          <InfoPanel title="Raw AWS Response Data" icon="{}">
            <div style={{ padding: 16 }}>
              <pre style={{
                background: '#e2e8f0', borderRadius: 10, padding: 16,
                margin: 0, fontSize: 12, color: '#7dd3fc',
                overflowX: 'auto', maxHeight: 500, lineHeight: 1.65,
              }}>
                {JSON.stringify(raw, null, 2)}
              </pre>
            </div>
          </InfoPanel>
        );
    }
  };

  return (
    <div style={PAGE}>
      {/* Back */}
      <button onClick={() => navigate('/cloud/resources')} style={BACK_BTN}>
        ← Resource Inventory
      </button>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(30,41,59,0.98) 0%, rgba(15,23,42,0.99) 100%)',
        border: '1px solid #e2e8f0',
        borderRadius: 20, padding: '28px 32px', marginBottom: 24,
        position: 'relative', overflow: 'hidden',
      }}>
        {/* glow */}
        <div style={{
          position: 'absolute', top: -80, right: -80, width: 280, height: 280, pointerEvents: 'none',
          background: `radial-gradient(circle, ${typeMeta.color}1a 0%, transparent 70%)`,
        }} />

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, position: 'relative' }}>
          {/* Icon */}
          <div style={{
            width: 72, height: 72, borderRadius: 18, flexShrink: 0,
            background: `${typeMeta.color}18`,
            border: `1.5px solid ${typeMeta.color}44`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 34,
          }}>{typeMeta.icon}</div>

          {/* Title */}
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#1e293b', letterSpacing: -0.3 }}>
                {resource.resource_name}
              </h1>
              <span style={{
                background: sc.bg, border: `1px solid ${sc.dot}44`, color: sc.fg,
                fontSize: 11, fontWeight: 700, padding: '3px 12px',
                borderRadius: 20, textTransform: 'uppercase', letterSpacing: 0.5,
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc.dot, display: 'inline-block' }} />
                {resource.status || 'UNKNOWN'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{
                background: `${typeMeta.color}18`, border: `1px solid ${typeMeta.color}33`,
                color: typeMeta.color, fontSize: 12, fontWeight: 700,
                padding: '3px 12px', borderRadius: 8,
              }}>{typeMeta.label}</span>
              <span style={{ color: '#64748b', fontSize: 13 }}>📍 {resource.region_or_zone}</span>
              {resource.ip_address && <span style={{ color: '#64748b', fontSize: 13 }}>🌐 {resource.ip_address}</span>}
            </div>
            <p style={{ margin: '8px 0 0', color: '#475569', fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {resource.provider_resource_id}
            </p>
          </div>
        </div>

        {/* Stat row */}
        <div style={{ display: 'flex', gap: 12, marginTop: 22, flexWrap: 'wrap' }}>
          {[
            { icon: '🕐', label: 'Discovered', value: resource.discovered_at ? new Date(resource.discovered_at).toLocaleDateString() : '—' },
            { icon: '🏷️', label: 'Tags', value: tagCount.toString() },
            { icon: '⚙️', label: 'Config Fields', value: configCount.toString() },
            { icon: '💰', label: 'Cost/mo', value: resource.cost_monthly != null ? `$${Number(resource.cost_monthly).toFixed(2)}` : 'N/A' },
            ...extraStats.map(s => ({ icon: s.icon, label: s.label, value: s.value })),
          ].map(s => (
            <div key={s.label} style={{
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 10, padding: '10px 16px', minWidth: 90,
            }}>
              <div style={{ color: '#64748b', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                {s.icon} {s.label}
              </div>
              <div style={{ color: '#334155', fontSize: 14, fontWeight: 700, marginTop: 3 }}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 3,
        background: '#f8fafc',
        border: '1px solid #e2e8f0',
        borderRadius: 12, padding: 3, marginBottom: 20,
      }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            flex: 1, padding: '9px 14px', borderRadius: 9, border: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: activeTab === tab ? 700 : 500, fontFamily: 'inherit',
            background: activeTab === tab ? 'rgba(96,165,250,0.18)' : 'transparent',
            color: activeTab === tab ? '#60a5fa' : '#64748b',
            transition: 'all 0.15s',
          }}>
            {tab}
          </button>
        ))}
      </div>

      {/* ── Content ──────────────────────────────────────────────────── */}
      {renderTabContent()}
    </div>
  );
};

function Empty({ icon, msg }: { icon: string; msg: string }) {
  return (
    <div style={{
      textAlign: 'center', padding: '60px 24px',
      background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 14,
    }}>
      <div style={{ fontSize: 36, marginBottom: 10 }}>{icon}</div>
      <p style={{ color: '#64748b', fontSize: 14, margin: 0 }}>{msg}</p>
    </div>
  );
}

const PAGE: React.CSSProperties = {
  minHeight: '100%',
  background: '#f1f5f9',
  padding: '28px 32px',
  fontFamily: "'Inter', -apple-system, sans-serif",
};

const BACK_BTN: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  marginBottom: 20, padding: '8px 16px',
  background: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 10, color: '#94a3b8', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
};
