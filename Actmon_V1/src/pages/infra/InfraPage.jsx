import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { listInstances, registerInstance, getInfraDetail } from '../../api/infra';
import { useToast } from '../../components/ui/ToastProvider';
import { DataTable } from '../../components/ui/DataTable';
import { DrawerPanel } from '../../components/ui/DrawerPanel';
import { StatusPill } from '../../components/ui/StatusPill';
import { KPICard } from '../../components/ui/KPICard';
import {
  Button,
  Spinner,
  Field,
  Input,
  Select,
  Card,
} from '@fluentui/react-components';
import {
  HardDrive,
  Plus,
  Search,
  Cpu,
  Layers,
  Activity,
  ServerCrash,
  Info,
  ShieldCheck,
} from 'lucide-react';

export const InfraPage = () => {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [registerDrawerOpen, setRegisterDrawerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  // Form setup
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({
    defaultValues: {
      name: '',
      ip_address: '',
      instance_type: 'Virtual Machine',
      environment: 'Production',
      os_version: 'RHEL 8.8',
      cpu_cores: 4,
      total_memory_gb: 16,
    },
  });

  // Query instances
  const {
    data: instances = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['infraInstances'],
    queryFn: listInstances,
  });

  // Query detail for selected instance
  const { data: detailData, isLoading: isDetailLoading } = useQuery({
    queryKey: ['infraDetail', selectedId],
    queryFn: () => getInfraDetail(selectedId),
    enabled: selectedId !== null,
  });

  // Mutation for registration
  const registerMutation = useMutation({
    mutationFn: registerInstance,
    onSuccess: (data) => {
      addToast(`Infrastructure target "${data.name}" registered.`, 'success');
      setRegisterDrawerOpen(false);
      queryClient.invalidateQueries({ queryKey: ['infraInstances'] });
      reset();
    },
    onError: (err) => {
      addToast(
        err.response?.data?.message ||
          err.message ||
          'Failed to register infrastructure target.',
        'error'
      );
    },
  });

  const onSubmit = (data) => {
    // Coerce numeric inputs from string to numbers
    const payload = {
      ...data,
      cpu_cores: Number(data.cpu_cores),
      total_memory_gb: Number(data.total_memory_gb),
    };
    registerMutation.mutate(payload);
  };

  // Filtered instances list
  const filteredInstances = useMemo(() => {
    if (!searchQuery.trim()) return instances;
    const query = searchQuery.toLowerCase();
    return instances.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.ip_address.toLowerCase().includes(query) ||
        item.instance_type.toLowerCase().includes(query) ||
        item.environment.toLowerCase().includes(query) ||
        item.os_version.toLowerCase().includes(query)
    );
  }, [instances, searchQuery]);

  // Compute metrics
  const totalCount = instances.length;
  const activeCount = instances.filter((x) => x.status === 'Online').length;
  const issueCount = instances.filter(
    (x) => x.status === 'Critical' || x.status === 'Offline'
  ).length;
  const totalCores = instances.reduce((sum, item) => sum + (item.cpu_cores || 0), 0);
  const totalRAM = instances.reduce((sum, item) => sum + (item.total_memory_gb || 0), 0);

  const columns = [
    {
      key: 'name',
      label: 'Target Hostname',
      sortable: true,
      render: (item) => (
        <span className="font-semibold text-brand-text-primary flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-brand-primary" />
          <span>{item.name}</span>
        </span>
      ),
    },
    {
      key: 'ip_address',
      label: 'IP Address',
      sortable: true,
    },
    {
      key: 'instance_type',
      label: 'Type',
      sortable: true,
      render: (item) => (
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-gray-100 text-gray-700">
          {item.instance_type}
        </span>
      ),
    },
    {
      key: 'environment',
      label: 'Environment',
      sortable: true,
      render: (item) => (
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded ${
            item.environment === 'Production'
              ? 'bg-red-50 text-[#A4262C] border border-red-100'
              : item.environment === 'Staging'
              ? 'bg-amber-50 text-[#9a6200] border border-amber-100'
              : 'bg-green-50 text-[#107C10] border border-green-100'
          }`}
        >
          {item.environment}
        </span>
      ),
    },
    {
      key: 'cpu_cores',
      label: 'vCPU Cores',
      sortable: true,
      render: (item) => `${item.cpu_cores} Cores`,
    },
    {
      key: 'total_memory_gb',
      label: 'RAM (GB)',
      sortable: true,
      render: (item) => `${item.total_memory_gb} GB`,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (item) => <StatusPill status={item.status} />,
    },
  ];

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-20 bg-white border border-brand-border rounded-card">
        <Spinner size="large" label="Querying infrastructure directory..." />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-8 text-center flex flex-col items-center justify-center border-brand-error/20 bg-red-50/10">
        <ServerCrash className="h-12 w-12 text-brand-error mb-2" />
        <h3 className="font-semibold text-brand-text-primary text-lg">
          Connection Error
        </h3>
        <p className="text-sm text-brand-text-secondary max-w-sm mt-1">
          Unable to establish communication with the target inventory. Verify the FastAPI daemon service is running.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Title block */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-text-primary flex items-center gap-2">
            <HardDrive className="h-6 w-6 text-brand-primary" />
            <span>Infrastructure Target Registry</span>
          </h1>
          <p className="text-sm text-brand-text-secondary">
            Manage hosts, compute nodes, and virtual machines hosting databases across environments.
          </p>
        </div>
        <div>
          <Button
            appearance="primary"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => {
              reset();
              setRegisterDrawerOpen(true);
            }}
          >
            Register Host Target
          </Button>
        </div>
      </div>

      {/* KPI Cards row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <KPICard
          label="Total Hosts"
          value={totalCount}
          icon={<HardDrive className="h-5 w-5" />}
        />
        <KPICard
          label="Online Nodes"
          value={activeCount}
          icon={<ShieldCheck className="h-5 w-5" />}
          trend={{
            value: totalCount > 0 ? `${Math.round((activeCount / totalCount) * 100)}%` : '0%',
            isPositive: activeCount === totalCount,
            label: 'Healthy ratio',
          }}
        />
        <KPICard
          label="Alerting Nodes"
          value={issueCount}
          icon={<Activity className="h-5 w-5" />}
          trend={{
            value: issueCount,
            isPositive: issueCount === 0,
            label: 'Degraded targets',
          }}
        />
        <KPICard
          label="Provisioned Compute"
          value={`${totalCores} vCPUs`}
          icon={<Cpu className="h-5 w-5" />}
        />
        <KPICard
          label="Provisioned Memory"
          value={`${totalRAM} GB`}
          icon={<Layers className="h-5 w-5" />}
        />
      </div>

      {/* Search Filter input */}
      <div className="flex items-center gap-3 bg-white p-4 border border-brand-border rounded-card shadow-card">
        <div className="relative flex-grow max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search targets by hostname, IP address, OS version or env..."
            className="w-full pl-9 pr-4"
          />
        </div>
        {searchQuery && (
          <Button appearance="subtle" size="small" onClick={() => setSearchQuery('')}>
            Clear
          </Button>
        )}
      </div>

      {/* Data Table */}
      <DataTable
        columns={columns}
        data={filteredInstances}
        rowKeyField="id"
        onRowClick={(item) => setSelectedId(item.id)}
        emptyState={
          <div className="text-center py-12 text-brand-text-secondary">
            No infrastructure targets found. Click 'Register Host Target' to begin.
          </div>
        }
      />

      {/* Host Registration Drawer */}
      <DrawerPanel
        open={registerDrawerOpen}
        onClose={() => setRegisterDrawerOpen(false)}
        title="Register Host Target"
      >
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field label="Hostname / Target Name" required validationState={errors.name ? 'error' : 'none'} validationMessage={errors.name && 'Name is required'}>
            <Input {...register('name', { required: true })} placeholder="e.g. vm-db-oracle-prod-01" />
          </Field>

          <Field label="IP Address" required validationState={errors.ip_address ? 'error' : 'none'} validationMessage={errors.ip_address && 'IP Address is required'}>
            <Input {...register('ip_address', { required: true })} placeholder="e.g. 192.168.12.50" />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Instance Type" required>
              <Select {...register('instance_type')}>
                <option value="Virtual Machine">Virtual Machine</option>
                <option value="Bare Metal Host">Bare Metal Host</option>
                <option value="Container Service">Container Service</option>
                <option value="Database Managed Instance">Database Managed Instance</option>
              </Select>
            </Field>

            <Field label="OS / Engine Version" required>
              <Input {...register('os_version', { required: true })} placeholder="e.g. RHEL 8.8, Win Server 2022" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="vCPU Cores" required validationState={errors.cpu_cores ? 'error' : 'none'} validationMessage={errors.cpu_cores && 'Cores must be a positive number'}>
              <Input {...register('cpu_cores', { required: true, min: 1 })} type="number" />
            </Field>

            <Field label="RAM Capacity (GB)" required validationState={errors.total_memory_gb ? 'error' : 'none'} validationMessage={errors.total_memory_gb && 'RAM must be a positive number'}>
              <Input {...register('total_memory_gb', { required: true, min: 1 })} type="number" />
            </Field>
          </div>

          <Field label="Environment Profile" required>
            <Select {...register('environment')}>
              <option value="Production">Production</option>
              <option value="Staging">Staging</option>
              <option value="Development">Development</option>
            </Select>
          </Field>

          <div className="flex gap-2 pt-6 justify-end border-t border-brand-border mt-6">
            <Button type="button" appearance="secondary" onClick={() => setRegisterDrawerOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" appearance="primary" disabled={registerMutation.isPending}>
              {registerMutation.isPending ? <Spinner size="tiny" label="Saving..." /> : 'Register Host'}
            </Button>
          </div>
        </form>
      </DrawerPanel>

      {/* Target Details Drawer */}
      <DrawerPanel
        open={selectedId !== null}
        onClose={() => setSelectedId(null)}
        title={detailData ? `Host Details: ${detailData.name}` : 'Querying Target details...'}
      >
        {isDetailLoading ? (
          <div className="flex justify-center items-center py-20">
            <Spinner size="medium" label="Loading target specification..." />
          </div>
        ) : detailData ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between bg-[#FAF9F8] p-4 border border-brand-border rounded-md">
              <span className="text-xs font-semibold text-brand-text-secondary uppercase">Operational Status</span>
              <StatusPill status={detailData.status} />
            </div>

            <div className="space-y-4">
              <h4 className="font-bold text-sm text-brand-text-primary border-b border-brand-border pb-1">
                Node Specification
              </h4>
              <div className="grid grid-cols-2 gap-y-4 gap-x-2 text-sm">
                <div>
                  <span className="block text-xs text-brand-text-secondary">Host Identifier</span>
                  <span className="font-semibold text-brand-text-primary">{detailData.name}</span>
                </div>
                <div>
                  <span className="block text-xs text-brand-text-secondary">IP Address</span>
                  <span className="font-semibold text-brand-text-primary">{detailData.ip_address}</span>
                </div>
                <div>
                  <span className="block text-xs text-brand-text-secondary">Instance Type</span>
                  <span className="font-semibold text-brand-text-primary">{detailData.instance_type}</span>
                </div>
                <div>
                  <span className="block text-xs text-brand-text-secondary">Environment Profile</span>
                  <span className="font-semibold text-brand-text-primary">{detailData.environment}</span>
                </div>
                <div>
                  <span className="block text-xs text-brand-text-secondary">OS Version</span>
                  <span className="font-semibold text-brand-text-primary">{detailData.os_version}</span>
                </div>
                <div>
                  <span className="block text-xs text-brand-text-secondary">System ID</span>
                  <span className="font-mono text-xs text-brand-text-primary">#{detailData.id}</span>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="font-bold text-sm text-brand-text-primary border-b border-brand-border pb-1">
                Compute Allocations
              </h4>
              <div className="grid grid-cols-2 gap-4">
                <Card className="p-3 border border-brand-border bg-[#FAF9F8]">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-5 w-5 text-brand-primary" />
                    <div>
                      <span className="block text-[10px] text-brand-text-secondary uppercase">Processor Capacity</span>
                      <span className="text-base font-bold text-brand-text-primary">{detailData.cpu_cores} Cores</span>
                    </div>
                  </div>
                </Card>
                <Card className="p-3 border border-brand-border bg-[#FAF9F8]">
                  <div className="flex items-center gap-2">
                    <Layers className="h-5 w-5 text-brand-primary" />
                    <div>
                      <span className="block text-[10px] text-brand-text-secondary uppercase">Memory Allocation</span>
                      <span className="text-base font-bold text-brand-text-primary">{detailData.total_memory_gb} GB RAM</span>
                    </div>
                  </div>
                </Card>
              </div>
            </div>

            <div className="bg-blue-50/30 border border-blue-100 p-4 rounded-md flex items-start gap-2.5">
              <Info className="h-4 w-4 text-brand-primary flex-shrink-0 mt-0.5" />
              <div className="text-xs text-brand-text-secondary leading-relaxed">
                Resource usage metrics and database instances configured on this host target are automatically synchronized by active agents. Use the <strong>Agents</strong> tab to view performance metrics.
              </div>
            </div>

            <div className="flex justify-end pt-6 border-t border-brand-border">
              <Button appearance="secondary" onClick={() => setSelectedId(null)}>
                Close Panel
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-center py-10 text-brand-text-secondary">
            Failed to load target details.
          </div>
        )}
      </DrawerPanel>
    </div>
  );
};
