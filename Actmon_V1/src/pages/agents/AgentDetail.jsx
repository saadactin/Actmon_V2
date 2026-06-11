import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  useAgentDashboard,
  useAgentMetrics,
  useAgentSQL,
  useAgentWaitEvents,
  useOracleSnapshot,
} from '../../hooks/useAgents';
import { exportCSV } from '../../api/agents';
import { MetricLineChart } from '../../components/charts/MetricLineChart';
import { WaitEventChart } from '../../components/charts/WaitEventChart';
import { DataTable } from '../../components/ui/DataTable';
import { StatusPill } from '../../components/ui/StatusPill';
import { DBTypeBadge } from '../../components/ui/DBTypeBadge';
import { formatUptime, formatBytes } from '../../utils/formatters';
import {
  Spinner,
  Button,
  TabList,
  Tab,
  Card,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Select,
} from '@fluentui/react-components';
import { ArrowLeft, Download, RefreshCw, BarChart2, Database, Table, HelpCircle } from 'lucide-react';

export const AgentDetail = () => {
  const { id = '' } = useParams();
  const [hours, setHours] = useState(6);
  const [activeTab, setActiveTab] = useState('perf');

  // Fetch agent dashboard status
  const { data: dashboard, isLoading: dashLoading, refetch: dashRefetch } = useAgentDashboard(id, hours);

  // Fetch metrics data
  const { data: metrics = [], isLoading: metricsLoading } = useAgentMetrics(id, hours);

  // Fetch SQL data
  const { data: sqlList = [], isLoading: sqlLoading } = useAgentSQL(id, hours);

  // Fetch wait events data
  const { data: waitList = [], isLoading: waitsLoading } = useAgentWaitEvents(id, hours);

  const isOracle = dashboard?.db_type === 'Oracle';
  // Fetch Oracle Snapshot metadata
  const { data: oracleSnap, isLoading: snapLoading } = useOracleSnapshot(id, isOracle);

  const handleExport = () => {
    exportCSV(id, hours);
  };

  const handleRefresh = () => {
    dashRefetch();
  };

  // Convert Wait Event items for Recharts WaitEventChart
  const waitChartData = waitList.map((item) => ({
    event: item.event_name,
    time_ms: item.time_waited_ms,
    percentage: undefined, // WaitEventChart calculates sorting
  }));

  const sqlColumns = [
    {
      key: 'sql_id',
      label: 'SQL ID',
      sortable: true,
      render: (s) => <code className="text-xs bg-gray-100 px-1 py-0.5 rounded font-mono">{s.sql_id}</code>,
    },
    {
      key: 'executions',
      label: 'Executions',
      sortable: true,
      render: (s) => (s.executions || 0).toLocaleString(),
    },
    {
      key: 'avg_elapsed_ms',
      label: 'Avg Elapsed (ms)',
      sortable: true,
      render: (s) => (s.avg_elapsed_ms || 0).toFixed(2),
    },
    {
      key: 'cpu_time_ms',
      label: 'CPU Time (ms)',
      sortable: true,
      render: (s) => (s.cpu_time_ms || 0).toLocaleString(),
    },
    {
      key: 'buffer_gets',
      label: 'Buffer Gets',
      sortable: true,
      render: (s) => (s.buffer_gets || 0).toLocaleString(),
    },
    {
      key: 'sql_text',
      label: 'SQL Statement',
      render: (s) => (
        <div className="max-w-md truncate font-mono text-xs text-brand-text-secondary" title={s.sql_text}>
          {s.sql_text}
        </div>
      ),
    },
  ];

  if (dashLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner size="large" label={`Fetching agent stats for ${id}...`} />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="space-y-6">
        <Link to="/agents" className="inline-flex items-center gap-2 text-sm text-brand-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to Agents
        </Link>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Node Not Found</MessageBarTitle>
            The monitoring agent "{id}" could not be located on the server.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Detail Header block */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-brand-border pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Link to="/agents" className="text-gray-400 hover:text-brand-primary p-1 hover:bg-gray-100 rounded">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-2xl font-bold text-brand-text-primary">{dashboard.agent_name}</h1>
            <DBTypeBadge type={dashboard.db_type} />
            <StatusPill status={dashboard.status} />
          </div>
          <p className="text-xs text-brand-text-secondary">
            Hostname: <span className="font-semibold">{dashboard.hostname}</span> | IP: <span className="font-semibold">{dashboard.ip_address}</span> | OS: <span className="font-semibold">{dashboard.os_type}</span> | Env: <span className="font-semibold">{dashboard.environment}</span>
          </p>
        </div>
        
        {/* Actions bar */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Time range selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-brand-text-secondary font-semibold">Time horizon:</span>
            <Select value={hours} onChange={(_, d) => setHours(Number(d.value))} size="small">
              <option value={1}>Last Hour</option>
              <option value={6}>Last 6 Hours</option>
              <option value={12}>Last 12 Hours</option>
              <option value={24}>Last 24 Hours</option>
              <option value={48}>Last 48 Hours</option>
            </Select>
          </div>
          <Button icon={<RefreshCw className="h-4 w-4" />} size="small" onClick={handleRefresh}>
            Refresh
          </Button>
          <Button icon={<Download className="h-4 w-4" />} size="small" onClick={handleExport}>
            Export CSV
          </Button>
        </div>
      </div>

      {/* Instance live stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4 bg-white border border-brand-border rounded-card shadow-card flex flex-col justify-between">
          <p className="text-xs font-semibold text-brand-text-secondary uppercase">Host CPU Load</p>
          <h3 className="text-xl font-bold text-brand-text-primary mt-2">
            {dashboard.metrics?.host_cpu != null ? `${dashboard.metrics.host_cpu.toFixed(1)}%` : '0.0%'}
          </h3>
        </Card>
        <Card className="p-4 bg-white border border-brand-border rounded-card shadow-card flex flex-col justify-between">
          <p className="text-xs font-semibold text-brand-text-secondary uppercase">Host RAM Load</p>
          <h3 className="text-xl font-bold text-brand-text-primary mt-2">
            {dashboard.metrics?.host_memory != null ? `${dashboard.metrics.host_memory.toFixed(1)}%` : '0.0%'}
          </h3>
        </Card>
        <Card className="p-4 bg-white border border-brand-border rounded-card shadow-card flex flex-col justify-between">
          <p className="text-xs font-semibold text-brand-text-secondary uppercase">Database CPU</p>
          <h3 className="text-xl font-bold text-brand-text-primary mt-2">
            {dashboard.metrics?.db_cpu != null ? `${dashboard.metrics.db_cpu.toFixed(1)}%` : '0.0%'}
          </h3>
        </Card>
        <Card className="p-4 bg-white border border-brand-border rounded-card shadow-card flex flex-col justify-between">
          <p className="text-xs font-semibold text-brand-text-secondary uppercase">Active Sessions / Uptime</p>
          <h3 className="text-xl font-bold text-brand-text-primary mt-2">
            {dashboard.metrics?.active_sessions ?? 0} / {formatUptime(dashboard.metrics?.uptime_seconds ?? 0)}
          </h3>
        </Card>
      </div>

      {/* Tabs configuration */}
      <div className="space-y-4">
        <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value)}>
          <Tab id="perf" value="perf" icon={<BarChart2 className="h-4 w-4" />}>Performance Charts</Tab>
          <Tab id="sql" value="sql" icon={<Table className="h-4 w-4" />}>Top SQL Statements</Tab>
          <Tab id="waits" value="waits" icon={<HelpCircle className="h-4 w-4" />}>Wait Events</Tab>
          {isOracle && <Tab id="snapshot" value="snapshot" icon={<Database className="h-4 w-4" />}>Oracle Snapshot</Tab>}
        </TabList>

        <div className="bg-white p-5 border border-brand-border rounded-card shadow-card min-h-[350px]">
          {activeTab === 'perf' && (
            <div className="space-y-6">
              {metricsLoading ? (
                <div className="flex justify-center items-center h-64"><Spinner label="Loading telemetry..." /></div>
              ) : metrics.length === 0 ? (
                <div className="text-center text-brand-text-secondary py-12">No telemetry metrics recorded for this time range.</div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-brand-text-primary">Host CPU & Memory Usage (%)</h3>
                    <MetricLineChart
                      data={metrics}
                      metrics={[
                        { key: 'host_cpu', name: 'Host CPU', color: '#0078D4' },
                        { key: 'host_memory', name: 'Host RAM', color: '#8764B8' },
                      ]}
                    />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-brand-text-primary">Database CPU (%) & Active Sessions</h3>
                    <MetricLineChart
                      data={metrics}
                      metrics={[
                        { key: 'db_cpu', name: 'DB CPU', color: '#D83B01' },
                        { key: 'active_sessions', name: 'Active Sessions', color: '#107C10', yAxisId: 'right' },
                      ]}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'sql' && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-brand-text-primary">Top SQL Statements by Resource Utilization</h3>
              {sqlLoading ? (
                <div className="flex justify-center items-center h-64"><Spinner label="Loading statements analysis..." /></div>
              ) : sqlList.length === 0 ? (
                <div className="text-center text-brand-text-secondary py-12">No active SQL metrics found.</div>
              ) : (
                <DataTable columns={sqlColumns} data={sqlList} rowKeyField="sql_id" />
              )}
            </div>
          )}

          {activeTab === 'waits' && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-brand-text-primary">Wait Events Metrics</h3>
              {waitsLoading ? (
                <div className="flex justify-center items-center h-64"><Spinner label="Loading wait profile..." /></div>
              ) : waitList.length === 0 ? (
                <div className="text-center text-brand-text-secondary py-12">No wait events recorded for this engine.</div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
                  <div className="lg:col-span-2">
                    <WaitEventChart data={waitChartData} />
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-4 text-xs text-brand-text-secondary">
                    <h4 className="font-bold text-brand-text-primary text-sm">Understanding Database Waits</h4>
                    <p>Wait events indicate the resource bottleneck for your query execution engine. Common wait classes include:</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li><strong>User I/O:</strong> Waiting on read/write storage access operations.</li>
                      <li><strong>System I/O:</strong> Redo log syncs or background writer processes.</li>
                      <li><strong>Concurrency:</strong> Lock contention, latches, or row level locks.</li>
                      <li><strong>CPU / Idle:</strong> Threads waiting for tasks or processing.</li>
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'snapshot' && isOracle && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-brand-text-primary">Oracle Database Instance Snapshot</h3>
              {snapLoading ? (
                <div className="flex justify-center items-center h-64"><Spinner label="Querying V$INSTANCE..." /></div>
              ) : !oracleSnap ? (
                <div className="text-center text-brand-text-secondary py-12">Could not retrieve metadata details.</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">Database Version</p>
                    <p className="font-bold text-brand-text-primary">{oracleSnap.version}</p>
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">Instance Name / SID</p>
                    <p className="font-bold text-brand-text-primary">{oracleSnap.instance_name}</p>
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">Startup Time</p>
                    <p className="font-bold text-brand-text-primary">{new Date(oracleSnap.startup_time).toLocaleString()}</p>
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">SGA Allocation Size</p>
                    <p className="font-bold text-brand-text-primary">{formatBytes(oracleSnap.sga_size_bytes)}</p>
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">PGA Allocation Size</p>
                    <p className="font-bold text-brand-text-primary">{formatBytes(oracleSnap.pga_size_bytes)}</p>
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">Log Archiving Mode</p>
                    <p className="font-bold text-brand-text-primary">{oracleSnap.log_mode} ({oracleSnap.archiver})</p>
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">Instance Status</p>
                    <p className="font-bold text-brand-text-primary">{oracleSnap.status}</p>
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">Database Open Mode</p>
                    <p className="font-bold text-brand-text-primary">{oracleSnap.open_mode} ({oracleSnap.database_status})</p>
                  </div>
                  <div className="p-4 bg-gray-50 border border-brand-border rounded-card space-y-1">
                    <p className="text-xs text-brand-text-secondary uppercase">Cluster Instance Role</p>
                    <p className="font-bold text-brand-text-primary">{oracleSnap.instance_role}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
