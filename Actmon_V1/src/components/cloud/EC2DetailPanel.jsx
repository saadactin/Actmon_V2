import { Server, Cpu, DollarSign, HardDrive, Shield } from 'lucide-react';
import { KPICard } from '../ui/KPICard';
import { DataTable } from '../ui/DataTable';
import { StatusPill } from '../ui/StatusPill';

export default function EC2DetailPanel({ data, resource }) {
  if (!data) return null;

  console.log('EC2DetailPanel received data:', data);

  // Map API response to expected format
  const instance_details = {
    instance_id: data.instance_id,
    instance_type: data.instance_type,
    state: data.state,
    launch_time: data.launch_time,
    availability_zone: data.availability_zone,
    platform: data.platform,
    vpc_id: data.vpc_id,
    subnet_id: data.subnet_id,
    private_ip: data.private_ip,
    public_ip: data.public_ip,
  };

  const metrics = data.metrics;
  const cost_estimate = data.cost_estimate;
  const volumes = data.volumes || [];
  const security_groups = data.security_groups || [];

  // Prepare volumes table data
  const volumeColumns = [
    { key: 'volume_id', label: 'Volume ID', width: '25%' },
    { key: 'size_gb', label: 'Size (GB)', width: '15%' },
    { key: 'type', label: 'Type', width: '15%' },
    { key: 'iops', label: 'IOPS', width: '15%' },
    { key: 'encrypted', label: 'Encrypted', width: '15%', render: (val) => val ? '✓ Yes' : '✗ No' },
    { key: 'device_name', label: 'Device', width: '15%' },
  ];

  // Format CPU utilization
  const cpuUtil = metrics?.cpu_utilization;
  const hasCPUData = cpuUtil && !cpuUtil.error && !cpuUtil.message;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4">
        <KPICard
          label="Instance Type"
          value={instance_details?.instance_type || 'N/A'}
          icon={Server}
        />
        <KPICard
          label="CPU Utilization (24h)"
          value={hasCPUData ? `${cpuUtil.avg_24h?.toFixed(1)}%` : 'No data'}
          icon={Cpu}
          subtext={hasCPUData ? `Peak: ${cpuUtil.max_24h?.toFixed(1)}%` : ''}
        />
        <KPICard
          label="Monthly Cost"
          value={`$${cost_estimate?.total_monthly?.toFixed(2) || '0.00'}`}
          icon={DollarSign}
          subtext={`Compute: $${cost_estimate?.compute_monthly?.toFixed(2) || '0.00'}`}
        />
        <KPICard
          label="Status"
          value={instance_details?.state || 'unknown'}
          icon={Server}
        />
      </div>

      {/* Instance Details */}
      <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">Instance Details</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-brand-text-secondary">Instance ID:</span>
            <span className="ml-2 font-mono text-brand-text-primary">{instance_details?.instance_id}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Platform:</span>
            <span className="ml-2 text-brand-text-primary">{instance_details?.platform || 'Linux/Unix'}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Availability Zone:</span>
            <span className="ml-2 text-brand-text-primary">{instance_details?.availability_zone}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">VPC ID:</span>
            <span className="ml-2 font-mono text-brand-text-primary">{instance_details?.vpc_id}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Private IP:</span>
            <span className="ml-2 font-mono text-brand-text-primary">{instance_details?.private_ip}</span>
          </div>
          <div>
            <span className="text-brand-text-secondary">Public IP:</span>
            <span className="ml-2 font-mono text-brand-text-primary">{instance_details?.public_ip || 'None'}</span>
          </div>
        </div>
      </div>

      {/* Network & Disk I/O */}
      {metrics && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary">Network & Disk I/O (24h)</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-brand-text-secondary mb-1">Network In</div>
              <div className="text-lg font-semibold text-brand-text-primary">
                {metrics.network?.data_in_gb_24h?.toFixed(2) || '0.00'} GB
              </div>
            </div>
            <div>
              <div className="text-xs text-brand-text-secondary mb-1">Network Out</div>
              <div className="text-lg font-semibold text-brand-text-primary">
                {metrics.network?.data_out_gb_24h?.toFixed(2) || '0.00'} GB
              </div>
            </div>
            <div>
              <div className="text-xs text-brand-text-secondary mb-1">Disk Read</div>
              <div className="text-lg font-semibold text-brand-text-primary">
                {metrics.disk_io?.read_gb_24h?.toFixed(2) || '0.00'} GB
              </div>
            </div>
            <div>
              <div className="text-xs text-brand-text-secondary mb-1">Disk Write</div>
              <div className="text-lg font-semibold text-brand-text-primary">
                {metrics.disk_io?.write_gb_24h?.toFixed(2) || '0.00'} GB
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Volumes */}
      {volumes && volumes.length > 0 && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
            <HardDrive className="h-4 w-4" />
            Attached Volumes ({volumes.length})
          </h3>
          <DataTable
            columns={volumeColumns}
            data={volumes}
            rowKeyField="volume_id"
          />
        </div>
      )}

      {/* Security Groups */}
      {security_groups && security_groups.length > 0 && (
        <div className="bg-white border border-brand-border rounded-card p-4 shadow-card">
          <h3 className="text-sm font-semibold mb-3 text-brand-text-primary flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Security Groups ({security_groups.length})
          </h3>
          <div className="flex flex-wrap gap-2">
            {security_groups.map((sg, idx) => (
              <StatusPill key={idx} status="active">
                {sg.name || sg.id || sg.group_name || sg.group_id}
              </StatusPill>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
