import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsList } from '../../hooks/useAgents';
import { DataTable } from '../../components/ui/DataTable';
import { DBTypeBadge } from '../../components/ui/DBTypeBadge';
import { StatusPill } from '../../components/ui/StatusPill';
import { MetricBar } from '../../components/ui/MetricBar';
import { formatTimeAgo } from '../../utils/formatters';
import { Spinner, Input, Combobox, Option } from '@fluentui/react-components';
import { Search } from 'lucide-react';

export const AgentsList = () => {
  const navigate = useNavigate();
  const { data: agents = [], isLoading } = useAgentsList();
  
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState('All');
  const [selectedEnv, setSelectedEnv] = useState('All');

  const handleRowClick = (agent) => {
    navigate(`/agents/${agent.name}`);
  };

  // Filter logic
  const filteredAgents = agents.filter((agent) => {
    const name = agent?.name || '';
    const hostname = agent?.hostname || '';
    const ipAddress = agent?.ip_address || '';
    
    const matchesSearch =
      name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      hostname.toLowerCase().includes(searchTerm.toLowerCase()) ||
      ipAddress.includes(searchTerm);

    const matchesType = selectedType === 'All' || agent?.db_type === selectedType;
    const matchesEnv = selectedEnv === 'All' || agent?.environment === selectedEnv;

    return matchesSearch && matchesType && matchesEnv;
  });

  const columns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (a) => <span className="font-semibold text-brand-primary hover:underline">{a.name}</span>,
    },
    {
      key: 'db_type',
      label: 'Engine',
      sortable: true,
      render: (a) => <DBTypeBadge type={a.db_type} />,
    },
    {
      key: 'hostname',
      label: 'Host',
      sortable: true,
    },
    {
      key: 'ip_address',
      label: 'IP Address',
    },
    {
      key: 'environment',
      label: 'Env',
      sortable: true,
      render: (a) => (
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-gray-150 text-gray-700">
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
      render: (a) => <MetricBar value={a.cpu_usage} />,
      cellClassName: 'w-36',
    },
    {
      key: 'memory_usage',
      label: 'Memory',
      sortable: true,
      render: (a) => <MetricBar value={a.memory_usage} />,
      cellClassName: 'w-36',
    },
    {
      key: 'last_heartbeat',
      label: 'Last Response',
      sortable: true,
      render: (a) => formatTimeAgo(a.last_heartbeat),
    },
  ];

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner size="large" label="Fetching systems inventory..." />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      <div>
        <h1 className="text-2xl font-bold text-brand-text-primary">Monitored Systems</h1>
        <p className="text-sm text-brand-text-secondary">
          Displaying registered target database and host monitor nodes.
        </p>
      </div>

      {/* Filter and search controls */}
      <div className="flex flex-col md:flex-row gap-4 p-4 bg-white border border-brand-border rounded-card shadow-card">
        {/* Search */}
        <div className="flex-1">
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by agent name, hostname, or IP..."
            contentBefore={<Search className="h-4 w-4 text-gray-400" />}
            className="w-full"
            style={{ width: '100%' }}
          />
        </div>

        {/* Engine filter */}
        <div className="w-full md:w-48">
          <Combobox
            placeholder="Filter Engine"
            selectedOptions={[selectedType]}
            onOptionSelect={(_, data) => setSelectedType(data.optionValue || 'All')}
            className="w-full"
          >
            <Option value="All">All Engines</Option>
            <Option value="Oracle">Oracle</Option>
            <Option value="PostgreSQL">PostgreSQL</Option>
            <Option value="MySQL">MySQL</Option>
            <Option value="MSSQL">MSSQL</Option>
            <Option value="MongoDB">MongoDB</Option>
            <Option value="ClickHouse">ClickHouse</Option>
          </Combobox>
        </div>

        {/* Env filter */}
        <div className="w-full md:w-48">
          <Combobox
            placeholder="Filter Env"
            selectedOptions={[selectedEnv]}
            onOptionSelect={(_, data) => setSelectedEnv(data.optionValue || 'All')}
            className="w-full"
          >
            <Option value="All">All Envs</Option>
            <Option value="Production">Production</Option>
            <Option value="Staging">Staging</Option>
            <Option value="Development">Development</Option>
          </Combobox>
        </div>
      </div>

      {/* Inventory table */}
      <DataTable
        columns={columns}
        data={filteredAgents}
        onRowClick={handleRowClick}
        rowKeyField="name"
        emptyState={
          <div className="text-center py-12 text-brand-text-secondary">
            No monitored agents match the selected search or filter criteria.
          </div>
        }
      />
    </div>
  );
};
