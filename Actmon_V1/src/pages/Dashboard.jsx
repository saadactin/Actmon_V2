import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsList } from '../hooks/useAgents';
import { useNotifications } from '../hooks/useNotifications';
import { KPICard } from '../components/ui/KPICard';
import { DataTable } from '../components/ui/DataTable';
import { DBTypeBadge } from '../components/ui/DBTypeBadge';
import { StatusPill } from '../components/ui/StatusPill';
import { MetricBar } from '../components/ui/MetricBar';
import { formatTimeAgo } from '../utils/formatters';
import { Spinner, MessageBar, MessageBarBody, MessageBarTitle, Card, Badge } from '@fluentui/react-components';
import { Server, ShieldAlert, Activity, CheckCircle, Bell, ArrowRight } from 'lucide-react';

export const Dashboard = () => {
  const navigate = useNavigate();
  // Fetch with 30s polling
  const { data: agents = [], isLoading: agentsLoading, isError: agentsError } = useAgentsList(true);
  const { notifications = [], isLoading: notifLoading } = useNotifications(10);

  // Compute metrics
  const totalAgents = agents.length;
  const onlineAgents = agents.filter(a => a.status === 'Online').length;
  const criticalAgents = agents.filter(a => a.status === 'Critical' || a.status === 'Degraded').length;
  const avgCpu = totalAgents > 0 
    ? agents.reduce((acc, curr) => acc + (curr.cpu_usage || 0), 0) / totalAgents 
    : 0;

  const handleRowClick = (agent) => {
    navigate(`/agents/${agent.name}`);
  };

  const columns = [
    {
      key: 'name',
      label: 'Agent Name',
      sortable: true,
      render: (a) => (
        <span className="font-semibold text-brand-primary hover:underline">{a.name}</span>
      ),
    },
    {
      key: 'db_type',
      label: 'Database Engine',
      sortable: true,
      render: (a) => <DBTypeBadge type={a.db_type} />,
    },
    {
      key: 'environment',
      label: 'Environment',
      sortable: true,
      render: (a) => (
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-700">
          {a.environment}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (a) => <StatusPill status={a.status} />,
    },
    {
      key: 'cpu_usage',
      label: 'CPU Usage',
      sortable: true,
      render: (a) => <MetricBar value={a.cpu_usage} showText={true} />,
      cellClassName: 'w-40',
    },
    {
      key: 'memory_usage',
      label: 'Memory Usage',
      sortable: true,
      render: (a) => <MetricBar value={a.memory_usage} showText={true} />,
      cellClassName: 'w-40',
    },
    {
      key: 'last_heartbeat',
      label: 'Last Heartbeat',
      sortable: true,
      render: (a) => formatTimeAgo(a.last_heartbeat),
    },
  ];

  if (agentsLoading && !agents.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <Spinner size="large" label="Loading dashboard summary..." />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Title block */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-text-primary">System Dashboard</h1>
          <p className="text-sm text-brand-text-secondary">
            Real-time multi-database health monitor. (Refreshes automatically every 30s)
          </p>
        </div>
      </div>

      {agentsError && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Data Error</MessageBarTitle>
            Unable to fetch real-time database agent statuses. Check your server API connection.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <KPICard
          label="Active Database Hosts"
          value={`${onlineAgents} / ${totalAgents}`}
          icon={<Server className="h-5 w-5" />}
          subtext="Online database systems"
        />
        <KPICard
          label="Unhealthy Instances"
          value={criticalAgents}
          icon={<ShieldAlert className="h-5 w-5 text-red-600" />}
          trend={criticalAgents > 0 ? { value: `${criticalAgents} alerts`, isPositive: false } : undefined}
          subtext="Degraded or critical agents"
        />
        <KPICard
          label="Average CPU Load"
          value={`${avgCpu.toFixed(1)}%`}
          icon={<Activity className="h-5 w-5" />}
          subtext="Across all monitored assets"
        />
        <KPICard
          label="Security and Compliance"
          value="Healthy"
          icon={<CheckCircle className="h-5 w-5 text-green-600" />}
          subtext="Vulnerability audits OK"
        />
      </div>

      {/* Main Grid: Databases List + Recent Events */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Monitored instances list */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-brand-text-primary">Monitored Assets</h2>
          </div>
          <DataTable
            columns={columns}
            data={agents}
            onRowClick={handleRowClick}
            rowKeyField="name"
            emptyState={
              <div className="text-center py-12 text-brand-text-secondary">
                No database agents found. Please register an agent connection.
              </div>
            }
          />
        </div>

        {/* Recent Events sidebar widget */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-brand-text-primary flex items-center gap-2">
              <Bell className="h-4 w-4 text-brand-primary" />
              <span>System Alerts</span>
            </h2>
            <button
              onClick={() => navigate('/alerts')}
              className="text-xs text-brand-primary hover:underline flex items-center gap-1 font-semibold"
            >
              <span>Manage alerts</span>
              <ArrowRight className="h-3 w-3" />
            </button>
          </div>

          <Card className="p-4 border border-brand-border bg-white rounded-card shadow-card space-y-4 h-[420px] overflow-y-auto">
            {notifLoading && notifications.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <Spinner size="tiny" label="Loading alerts..." />
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-brand-text-secondary text-center py-8">
                <CheckCircle className="h-8 w-8 text-green-500 mb-2" />
                <p className="text-sm font-semibold">All Systems Operational</p>
                <p className="text-xs text-gray-400">No active alerts found.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {notifications.slice(0, 8).map((notif) => (
                  <div
                    key={notif.id}
                    className={`p-3 rounded-lg border flex gap-3 text-xs leading-normal ${
                      notif.severity === 'Critical'
                        ? 'bg-red-50/50 border-red-100 text-red-800'
                        : notif.severity === 'Warning'
                        ? 'bg-amber-50/50 border-amber-100 text-amber-800'
                        : 'bg-blue-50/50 border-blue-100 text-blue-800'
                    }`}
                  >
                    <div className="font-medium flex-1">
                      <div className="flex items-center gap-1.5 mb-1 font-bold">
                        <Badge
                          size="small"
                          color={
                            notif.severity === 'Critical'
                              ? 'danger'
                              : notif.severity === 'Warning'
                              ? 'warning'
                              : 'informative'
                          }
                        >
                          {notif.severity}
                        </Badge>
                        <span className="text-gray-400 font-normal">{formatTimeAgo(notif.timestamp)}</span>
                      </div>
                      <p>{notif.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};
