import React from 'react';
import { useParams } from 'react-router-dom';
import { usePostgreSQLDashboard } from '../../hooks/useConnections';
import { Spinner, Button } from '@fluentui/react-components';
import { ArrowLeft, RefreshCw, Database, Activity, Cpu, Server, Network, Shield, FileText, Clock } from 'lucide-react';
import PostgreSQLHealthScore from './PostgreSQLHealthScore';
import PostgreSQLErrorCards from './PostgreSQLErrorCards';
import PostgreSQLAiDiagnosis from './PostgreSQLAiDiagnosis';
import PostgreSQLCharts from './PostgreSQLCharts';
import PostgreSQLLiveErrors from './PostgreSQLLiveErrors';

export default function PostgreSQLDashboard() {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = usePostgreSQLDashboard(id);

  if (isLoading) {
    return (
      <div className="flex flex-col justify-center items-center py-20 gap-4 min-h-[60vh]">
        <Spinner size="large" label="Gathering real-time database telemetry..." />
        <p className="text-sm text-slate-500 font-semibold">Running SHOW GLOBAL STATUS and system inspection</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button icon={<ArrowLeft />} appearance="subtle" onClick={() => window.history.back()}>Back</Button>
          <h1 className="text-2xl font-bold text-slate-800">Connection Error</h1>
        </div>
        <div className="bg-red-50 border-l-4 border-red-500 p-5 rounded-r-xl shadow-sm">
          <h3 className="font-bold text-red-800 text-lg">Failed to Retrieve Diagnostics</h3>
          <p className="text-red-700 mt-2 font-medium">Unable to contact backend server. Please verify the ActMon backend service is running.</p>
        </div>
        <Button appearance="primary" onClick={() => refetch()}>Retry Connection</Button>
      </div>
    );
  }

  if (data.status === 'error') {
    const conn = data.connection || {};
    return (
      <div className="space-y-6 animate-in fade-in duration-200">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-4 mb-6">
          <div className="flex items-center gap-3">
            <Button icon={<ArrowLeft />} appearance="subtle" onClick={() => window.history.back()}>Back</Button>
            <div>
              <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                <Database className="h-6 w-6 text-red-500" />
                ActMon - PostgreSQL Dashboard
              </h1>
              <p className="text-sm text-slate-500 mt-1">Profile: <strong>{conn.name || 'Unknown'}</strong> ({conn.host}:{conn.port})</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button icon={<RefreshCw />} appearance="primary" onClick={() => refetch()}>Retry Connection</Button>
            <Button appearance="secondary" onClick={() => { window.location.href = `/postgresql-dashboard/${id}/error-logs`; }}>Open Error Diagnosis Center</Button>
          </div>
        </div>

        <div className="bg-red-50 border-l-4 border-red-500 p-5 rounded-r-xl shadow-sm">
          <h3 className="font-bold text-red-800 text-lg">PostgreSQL Offline</h3>
          <p className="text-red-700 mt-2 font-semibold font-mono text-sm">{data.error}</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-xl font-bold text-[#0b1220] mb-4">PostgreSQL Offline Diagnosis</h2>
          <p className="text-slate-600 leading-relaxed mb-6">PostgreSQL credentials or endpoint login is not available, but ActMon can check active TCP reachability, inspect internal parameters, and verify target host resolution.</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Host</span>
              <p className="font-semibold text-slate-700 mt-1 font-mono">{conn.host || 'NA'}</p>
            </div>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Port</span>
              <p className="font-semibold text-slate-700 mt-1 font-mono">{conn.port || '5432'}</p>
            </div>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Database</span>
              <p className="font-semibold text-slate-700 mt-1">{conn.database || 'ALL'}</p>
            </div>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Status</span>
              <span className="inline-block mt-2 px-2 py-0.5 rounded bg-red-100 text-red-700 text-xs font-bold uppercase tracking-wider">UNREACHABLE</span>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-5 mt-5">
            <h4 className="font-bold text-slate-700 text-sm mb-2">Recommended Next Steps:</h4>
            <ul className="list-disc pl-5 text-sm text-slate-500 space-y-1">
              <li>Confirm that the PostgreSQL Server is running on host <strong>{conn.host}</strong></li>
              <li>Verify that security groups/firewalls permit TCP traffic on port <strong>{conn.port}</strong></li>
              <li>Verify connecting credentials (username/password) are correct</li>
              <li>Ensure the PostgreSQL server permits connection authorization from this monitoring server</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // Deconstruct telemetry variables
  const {
    connection = {},
    health_summary = {},
    databases = [],
    chart_data = {},
    connections_detail = {},
    memory = {},
    query_stats = {},
    network = {},
    slow_query_config = {},
    error_log_path = 'NA',
    error_log_count = 0,
    process_list = [],
    long_running_queries = [],
    replication = {}
  } = data;

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* HEADER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#0e466f] flex items-center gap-2">
            <Database className="h-6 w-6 text-[#00758f]" />
           ActMon - PostgreSQL Dashboard
          </h1>
          <p className="text-sm text-slate-500 mt-1">Connection Profile: <strong className="text-slate-800">{connection.name}</strong> ({connection.host}:{connection.port})</p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<ArrowLeft />} appearance="subtle" onClick={() => window.history.back()}>Back</Button>
         <Button
  icon={<RefreshCw />}
  appearance="primary"
  onClick={() => refetch()}
>
  Refresh Dashboard
</Button>
          <Button appearance="secondary" onClick={() => { window.location.href = `/postgresql-dashboard/${id}/error-logs`; }}> View Error Logs</Button>
        </div>
      </div>

      {/* HEALTH SCORE */}
      <PostgreSQLHealthScore health_summary={health_summary} connections_detail={connections_detail} replication={replication} />

      {/* ERROR CARDS */}
      <PostgreSQLErrorCards query_stats={query_stats} health_summary={health_summary} connections_detail={connections_detail} error_log_count={error_log_count} />

      {/* AI DIAGNOSIS */}
      <PostgreSQLAiDiagnosis query_stats={query_stats} connections_detail={connections_detail} long_running_queries={long_running_queries} />

      {/* CHARTS */}
      <PostgreSQLCharts health_summary={health_summary} memory={memory} chart_data={chart_data} connections_detail={connections_detail} />

      {/* LIVE ERRORS */}
      <PostgreSQLLiveErrors process_list={process_list} long_running_queries={long_running_queries} />

      </div>
  );
}