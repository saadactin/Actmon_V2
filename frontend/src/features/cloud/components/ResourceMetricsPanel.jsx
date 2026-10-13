import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { AlertTriangle, Activity, BarChart3, Clock, Info } from 'lucide-react';
import { getResourceMetrics } from '../api/resources.api';
import { DiagnosticModal } from './DiagnosticModal';
import Badge from '@/components/ui/Badge';
import { PageLoading } from '@/components/ui/Loading';
import CloudSection from './CloudSection';

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

/**
 * Real monitoring charts for a resource — CPU, memory, network, disk and
 * every other series the backend's provider-specific collector returned
 * (see metrics_service.py for the per-resource-type mapping).
 *
 * Shared between the resource detail page and the resource drawer so a chart
 * fix or a new metric mapping shows up in both places rather than one.
 */
export function MonitoringTabContent({ resourceId }) {
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
        ) : metricsData.saved ? (
          // AWS: read only during a refresh, so this is what the last one saved.
          <Badge tone="info" size="xs">
            <Clock size={12} />
            Saved at last refresh — {source}
          </Badge>
        ) : (
          <Badge tone="neutral" size="xs">
            <AlertTriangle size={12} />
            No live data — NA
          </Badge>
        )}
        <span className="text-meta text-muted">
          {metricsData.saved && metricsData.as_of
            ? `24h up to ${new Date(metricsData.as_of).toLocaleString()}`
            : 'Last 24h'}
        </span>
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
                <span className="text-meta font-semibold text-subtle">NA</span>
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
                <span className="text-meta font-normal normal-case tracking-normal text-subtle">(Last 24h)</span>
              </h4>
              <span className="text-meta font-semibold text-muted">
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

export default MonitoringTabContent;
