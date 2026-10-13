import { useMemo, useState } from 'react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import CopyButton from '@/components/ui/CopyButton';
import Icon from '@/components/ui/Icon';
import IconButton from '@/components/ui/IconButton';
import Notice from '@/components/ui/Notice';
import { Spinner } from '@/components/ui/Loading';
import {
  edgeStyle, formatCount, formatMoment, healthMeta, nodeBadges, providerMeta, typeMeta,
} from '../utils/topologyModel';

/**
 * The Resource Intelligence panel.
 *
 * The previous sidebar showed five fields and a list of connections. The point
 * of this one is that an investigation should not have to leave the topology:
 * identity, configuration, the security controls in force, the network path,
 * the storage attached, what depends on it, what it changed into and who
 * touched it are all here, each from a named source.
 *
 * ## Absent is not the same as empty
 *
 * Every value the provider did not report renders as "Not available" with the
 * reason, never as a blank, a dash that could be a value, or a plausible
 * default. This is the rule the whole feature turns on: a topology that
 * quietly fills in a missing subnet is worse than one that admits it does not
 * know, because you cannot tell the difference from the outside.
 */

const NOT_AVAILABLE = 'Not available';

function NotAvailable({ reason }) {
  return (
    <span className="inline-flex items-center gap-1 text-[12px] italic text-subtle" title={reason}>
      {NOT_AVAILABLE}
      {reason && <Icon name="info" size={11} className="opacity-60" />}
    </span>
  );
}

function Row({ label, value, mono, copy, reason }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="flex items-start justify-between gap-3 px-3.5 py-2">
      <dt className="shrink-0 pt-0.5 text-meta font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1.5 text-right">
        {empty ? (
          <NotAvailable reason={reason} />
        ) : (
          <>
            <span className={mono ? 'break-all font-mono text-meta text-fg' : 'break-words text-[13px] text-fg'}>
              {String(value)}
            </span>
            {copy && <CopyButton text={String(value)} label="" size="sm" variant="ghost" className="shrink-0" />}
          </>
        )}
      </dd>
    </div>
  );
}

function Section({ title, count, children, defaultOpen = true, hint }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-sunken"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="shrink-0 text-subtle" />
        <span className="flex-1 text-meta font-bold uppercase tracking-wider text-muted">{title}</span>
        {count !== undefined && count !== null && (
          <span className="shrink-0 rounded-full bg-sunken px-1.5 text-micro font-bold text-subtle">{count}</span>
        )}
      </button>
      {open && (
        <div className="pb-3">
          {hint && <p className="px-3.5 pb-2 text-meta leading-relaxed text-subtle">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

/* ── Configuration grouping ──────────────────────────────────────────────────
   Which config keys belong under which heading. Keys not listed appear under
   "Other configuration" rather than being dropped — a field we have not
   classified is still information, and hiding it would make the panel look
   more complete than it is. */
const CONFIG_SECTIONS = {
  network: {
    title: 'Network configuration',
    keys: [
      ['private_ip', 'Private IP'], ['public_ip', 'Public IP'], ['ip_address', 'IP address'],
      ['ip_addresses', 'IP addresses'], ['cidr_block', 'CIDR block'], ['cidr_blocks', 'CIDR blocks'],
      ['address_prefix', 'Address prefix'], ['available_ips', 'Available IPs'],
      ['public_ip_on_launch', 'Public IP on launch'], ['is_public', 'Public'],
      ['is_private', 'Private'], ['public_access_type', 'Public access'],
      ['public_network_access', 'Public network access'], ['publicly_accessible', 'Publicly accessible'],
      ['dns_label', 'DNS label'], ['domain_name', 'Domain name'], ['fqdn', 'FQDN'],
      ['hostname', 'Hostname'], ['endpoint', 'Endpoint'], ['service_url', 'Service URL'],
      ['invoke_endpoint', 'Invoke endpoint'], ['reader_endpoint', 'Reader endpoint'],
      ['port', 'Port'], ['listener_port', 'Listener port'], ['protocol', 'Protocol'],
      ['scheme', 'Scheme'], ['allocation_method', 'Allocation method'],
      ['accelerated_networking', 'Accelerated networking'], ['is_ipv6_enabled', 'IPv6 enabled'],
      ['bandwidth_shape_name', 'Bandwidth shape'], ['lb_type', 'Load balancer type'],
      ['route_type', 'Route type'], ['total_rules', 'Route rules'], ['route_rule_count', 'Route rules'],
    ],
  },
  security: {
    title: 'Security configuration',
    keys: [
      ['encrypted', 'Encrypted'], ['storage_encrypted', 'Storage encrypted'],
      ['at_rest_encrypted', 'Encrypted at rest'], ['transit_encrypted', 'Encrypted in transit'],
      ['encryption', 'Encryption'], ['kms_key_id', 'Customer-managed key'],
      ['is_stateless', 'Stateless rules'], ['public_access_block', 'Public access block'],
      ['allow_blob_public_access', 'Blob public access'], ['versioning', 'Versioning'],
      ['non_ssl_port_enabled', 'Non-SSL port enabled'], ['ssl_port', 'SSL port'],
      ['administrator_login', 'Administrator login'], ['master_username', 'Master username'],
      ['is_virtual_network_filter_enabled', 'VNet filter enabled'],
      ['statement_count', 'Policy statements'], ['web_app_firewall_policy_id', 'WAF policy'],
      ['certificate_id', 'Certificate'],
    ],
  },
  compute: {
    title: 'Compute configuration',
    keys: [
      ['instance_type', 'Instance type'], ['vm_size', 'VM size'], ['shape', 'Shape'],
      ['shape_name', 'Shape'], ['ocpus', 'OCPUs'], ['cpu_core_count', 'CPU cores'],
      ['memory_gb', 'Memory (GB)'], ['memory_mb', 'Memory (MB)'], ['memory_in_mbs', 'Memory (MB)'],
      ['platform', 'Platform'], ['os_type', 'OS type'], ['architecture', 'Architecture'],
      ['image_id', 'Image'], ['image', 'Image'], ['image_digest', 'Image digest'],
      ['runtime', 'Runtime'], ['handler', 'Handler'], ['timeout_s', 'Timeout (s)'],
      ['timeout_in_seconds', 'Timeout (s)'], ['power_state', 'Power state'],
      ['fault_domain', 'Fault domain'], ['availability_domain', 'Availability domain'],
      ['availability_zone', 'Availability zone'], ['node_count', 'Node count'],
      ['node_type', 'Node type'], ['kubernetes_version', 'Kubernetes version'],
      ['launch_time', 'Launched'], ['is_auto_scaling_enabled', 'Auto-scaling'],
      ['monitoring', 'Monitoring'], ['sku', 'SKU'], ['tier', 'Tier'], ['kind', 'Kind'],
      ['capacity', 'Capacity'], ['family', 'Family'], ['compute_model', 'Compute model'],
    ],
  },
  storage: {
    title: 'Storage configuration',
    keys: [
      ['size_gb', 'Size (GB)'], ['size_bytes', 'Size (bytes)'], ['storage_gb', 'Storage (GB)'],
      ['disk_size_gb', 'Disk size (GB)'], ['boot_volume_gb', 'Boot volume (GB)'],
      ['block_volume_gb', 'Block volume total (GB)'], ['block_volume_count', 'Block volumes'],
      ['attached_storage_gb', 'Attached storage (GB)'], ['data_storage_size_gb', 'Data storage (GB)'],
      ['data_storage_size_tbs', 'Data storage (TB)'], ['max_storage_gb', 'Max storage (GB)'],
      ['volume_type', 'Volume type'], ['storage_tier', 'Storage tier'], ['access_tier', 'Access tier'],
      ['iops', 'IOPS'], ['vpus_per_gb', 'VPUs per GB'], ['disk_state', 'Disk state'],
      ['metered_bytes', 'Metered bytes'], ['item_count', 'Item count'],
      ['attachment_status', 'Attachment status'], ['attached_to_name', 'Attached to'],
      ['attached_to_status', 'Attached instance state'], ['lifecycle_rules', 'Lifecycle rules'],
      ['geo_redundant_backup', 'Geo-redundant backup'], ['backup_enabled', 'Backup enabled'],
      ['backup_retention_days', 'Backup retention (days)'], ['disk_redundancy', 'Disk redundancy'],
    ],
  },
  database: {
    title: 'Database configuration',
    keys: [
      ['engine', 'Engine'], ['engine_version', 'Engine version'], ['db_name', 'Database name'],
      ['instance_class', 'Instance class'], ['multi_az', 'Multi-AZ'],
      ['database_edition', 'Edition'], ['edition', 'Edition'], ['db_workload', 'Workload'],
      ['license_model', 'License model'], ['license_type', 'License type'],
      ['mysql_version', 'MySQL version'], ['redis_version', 'Redis version'],
      ['version', 'Version'], ['collation', 'Collation'], ['consistency_level', 'Consistency level'],
      ['high_availability_mode', 'High availability'], ['is_highly_available', 'Highly available'],
      ['crash_recovery', 'Crash recovery'], ['read_capacity', 'Read capacity'],
      ['write_capacity', 'Write capacity'], ['billing_mode', 'Billing mode'],
      ['max_read_units', 'Max read units'], ['max_write_units', 'Max write units'],
      ['key_schema', 'Key schema'], ['serverless', 'Serverless'],
      ['cluster_enabled', 'Cluster enabled'], ['read_region_count', 'Read regions'],
    ],
  },
};

const ALL_CLASSIFIED = new Set(
  Object.values(CONFIG_SECTIONS).flatMap((section) => section.keys.map(([key]) => key)),
);

/* Config keys that are relationship identifiers. They are shown as
   relationships, not as opaque strings in a configuration table, so they are
   excluded here to avoid saying the same thing twice in two worse ways. */
const RELATIONSHIP_KEYS = new Set([
  'vpc_id', 'vcn_id', 'virtual_network_id', 'subnet_id', 'subnet_ids',
  'security_group_ids', 'security_groups', 'nsg_id', 'nsg_ids',
  'network_security_group_id', 'security_list_ids', 'route_table_id',
  'nat_gateway_id', 'role_arn', 'role', 'nic_ids', 'os_disk_id',
  'data_disk_ids', 'availability_set_id', 'public_ip_ids', 'managed_by',
  'application_id', 'default_route_table_id', 'default_security_list_id',
  'default_dhcp_options_id', 'attached_network_id', 'drg_id', 'gateway_id',
  'load_balancer_id', 'backend_instance_ids', 'backend_ips',
  'event_source_arns', 'accessible_resources', 'broad_access',
  'attached_to_id', 'route_rules', 'environment_variables',
  'inbound_rules', 'outbound_rules', 'ingress_rules', 'egress_rules',
]);

function renderConfigValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value.every((v) => typeof v !== 'object') ? value.join(', ') : `${value.length} entries`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return keys.length ? `${keys.length} fields` : null;
  }
  return String(value);
}

function ConfigTable({ config, keys }) {
  const rows = keys
    .map(([key, label]) => [label, renderConfigValue(config[key])])
    .filter(([, value]) => value !== null);
  if (!rows.length) return null;
  return (
    <dl className="mx-3.5 divide-y divide-border overflow-hidden rounded-control border border-border">
      {rows.map(([label, value]) => (
        <Row key={label} label={label} value={value} />
      ))}
    </dl>
  );
}

/* ── Relationship list ───────────────────────────────────────────────────── */
function RelationshipList({ items, onSelect, onExplain, emptyLabel }) {
  if (!items?.length) {
    return <p className="px-3.5 text-[12px] italic text-subtle">{emptyLabel}</p>;
  }
  return (
    <ul className="mx-3.5 flex flex-col gap-1.5">
      {items.map((item) => {
        const style = edgeStyle(item.relationship);
        const meta = typeMeta(item.type);
        return (
          <li key={`${item.edge_id}-${item.id}`}>
            <div className="flex items-stretch gap-1">
              <button
                type="button"
                onClick={() => onSelect?.(item.id)}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-control border border-border bg-surface px-2.5 py-2 text-left hover:border-strong hover:bg-accent-soft"
              >
                <span className="h-6 w-1 shrink-0 rounded-sm" style={{ background: meta.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-fg">{item.name || '—'}</span>
                  <span className="block truncate text-meta text-subtle">
                    {meta.label}
                    {item.label ? ` · ${item.label}` : ''}
                  </span>
                </span>
                <span
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-micro font-bold uppercase"
                  style={{ color: style.color, background: `${style.color}22` }}
                >
                  {style.label}
                </span>
                {item.observed === false && (
                  <span
                    className="shrink-0 text-micro font-bold text-subtle"
                    title="A capability granted by policy. NOT evidence that any access occurred."
                  >
                    MAY
                  </span>
                )}
              </button>
              <IconButton
                size="sm"
                icon="info"
                label="Why is this connected?"
                onClick={() => onExplain?.(item.edge_id)}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ── The panel ───────────────────────────────────────────────────────────── */
export default function TopologyResourcePanel({
  detail,
  loading,
  scope,
  onClose,
  onSelectNode,
  onExplainEdge,
  onShowImpact,
  onFindPathFrom,
  onViewEvents,
  onViewDrift,
  onOpenFullDetail,
  onRequestRaw,
  rawRequested,
  canViewRaw = true,
}) {
  const [tab, setTab] = useState('overview');

  const node = detail?.resource;
  const config = detail?.configuration || {};
  const metadata = detail?.metadata || {};

  const otherConfig = useMemo(() => {
    const entries = Object.entries(config)
      .filter(([key]) => !ALL_CLASSIFIED.has(key) && !RELATIONSHIP_KEYS.has(key))
      .map(([key, value]) => [key, renderConfigValue(value)])
      .filter(([, value]) => value !== null);
    return entries;
  }, [config]);

  if (loading && !detail) {
    return (
      <aside className="flex w-[400px] shrink-0 items-center justify-center rounded-card border border-border bg-surface">
        <Spinner size="lg" />
      </aside>
    );
  }

  if (detail && detail.found === false) {
    return (
      <aside className="w-[400px] shrink-0 overflow-y-auto rounded-card border border-border bg-surface p-4">
        <div className="mb-3 flex items-start justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-fg">Resource not in this topology</h3>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
        </div>
        <Notice tone="warning" title="Not found">{detail.detail}</Notice>
      </aside>
    );
  }

  if (!node) return null;

  const meta = typeMeta(node.type);
  const health = healthMeta(node.health);
  const provider = providerMeta(node.provider);
  const badges = nodeBadges(node);

  const permissions = (detail.outbound || []).filter((item) => item.relationship === 'permission');
  const dataflow = [
    ...(detail.inbound || []).filter((item) => item.relationship === 'dataflow'),
    ...(detail.outbound || []).filter((item) => item.relationship === 'dataflow'),
  ];
  const structural = (items) => items.filter((item) => !['permission', 'dataflow'].includes(item.relationship));

  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'relationships', label: `Relationships (${(detail.inbound?.length || 0) + (detail.outbound?.length || 0)})` },
    { id: 'config', label: 'Configuration' },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <aside
      className="flex w-[400px] shrink-0 flex-col overflow-hidden rounded-card border border-border bg-surface"
      aria-label={`Details for ${node.name}`}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-border p-3.5">
        <div className="mb-2 flex items-start gap-2.5">
          <span className="mt-0.5 h-9 w-1.5 shrink-0 rounded-full" style={{ background: meta.color }} />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="rounded border px-1.5 py-px text-micro font-bold" style={provider.badgeStyle}>
                {provider.label}
              </span>
              <span className="text-meta font-bold uppercase tracking-wide" style={{ color: meta.color }}>
                {meta.label}
              </span>
            </div>
            <h3 className="break-all text-[14.5px] font-semibold leading-snug text-fg">{node.name || '—'}</h3>
          </div>
          <IconButton icon="close" label="Close details" size="sm" onClick={onClose} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={node.status ? 'info' : 'neutral'} size="sm">
            {node.status || 'Status not reported'}
          </Badge>
          <Badge tone={health.tone} size="sm">{`Health: ${health.label}`}</Badge>
          {badges.filter((b) => !['default', 'synthetic'].includes(b.id)).map((badge) => (
            <Badge key={badge.id} tone={badge.tone} size="sm">
              <span title={badge.title}>{badge.label}</span>
            </Badge>
          ))}
        </div>
      </header>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 gap-px border-b border-border bg-sunken px-1.5 pt-1.5">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id}
            className={`rounded-t-control px-2.5 py-1.5 text-meta font-semibold transition-colors ${
              tab === entry.id ? 'bg-surface text-fg' : 'text-muted hover:text-fg'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'overview' && (
          <>
            <Section title="Identity" defaultOpen>
              <dl className="mx-3.5 divide-y divide-border overflow-hidden rounded-control border border-border">
                <Row label="Resource ID" value={node.provider_id} mono copy
                  reason="This resource was derived from an identifier rather than returned as a resource." />
                <Row label="Type" value={node.type} />
                <Row label="Category" value={node.category} />
                <Row label="Account" value={node.account_name} />
                <Row label="Account ID" value={node.account_id} mono copy />
                <Row label="Environment" value={node.environment} />
                <Row label="Region" value={node.region} />
                <Row label="Availability zone / domain" value={node.availability_zone}
                  reason="This resource type is not zonal, or the provider did not report a zone." />
                {node.subscription_id && <Row label="Subscription" value={node.subscription_id} mono copy />}
                {node.resource_group && <Row label="Resource group" value={node.resource_group} copy />}
                {node.compartment_name && <Row label="Compartment" value={node.compartment_name} />}
                {node.compartment_id && <Row label="Compartment OCID" value={node.compartment_id} mono copy />}
                <Row label="Monthly cost" value={
                  typeof node.cost === 'number' && node.cost > 0 ? node.cost.toFixed(2) : null
                } reason="No billed cost is recorded against this resource." />
              </dl>
            </Section>

            {/* Internet exposure — only when the exposure engine actually
                found a world-open port, and it always says how it decided. */}
            {node.exposed && (
              <Section title="Internet exposure" defaultOpen>
                <div className="mx-3.5 rounded-control border border-danger-border bg-danger-soft p-2.5">
                  <p className="text-[12px] font-semibold text-danger-fg">
                    Reachable from the internet · {node.exposure_severity}
                  </p>
                  <p className="mt-1 text-meta text-danger-fg/90">
                    Public address <span className="font-mono">{node.exposure_public_ip}</span>
                  </p>
                  {node.exposure_open_ports?.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {node.exposure_open_ports.map((port) => (
                        <li
                          key={`${port.protocol}-${port.port}-${port.label}`}
                          className="rounded bg-surface/70 px-1.5 py-0.5 text-meta font-semibold text-danger-fg"
                        >
                          {port.port ? `${port.port} ` : ''}{port.label}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-meta leading-relaxed text-danger-fg/80">
                    Confidence: {node.exposure_confidence}. Determined from the rules on the
                    security groups actually attached to this resource, not from its name.
                  </p>
                </div>
              </Section>
            )}

            {node.broad_access?.length > 0 && (
              <Section title="Account-wide access (IAM wildcard)" count={node.broad_access.length}
                hint="Its role grants these on every resource of that service, so no per-resource
                      relationship can be drawn — the policy names no specific target.">
                <div className="mx-3.5 flex flex-wrap gap-1">
                  {node.broad_access.map((grant) => (
                    <span
                      key={grant}
                      className="rounded-md px-1.5 py-0.5 text-meta font-semibold"
                      style={{ color: edgeStyle('permission').color, background: `${edgeStyle('permission').color}20` }}
                    >
                      {grant}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Dependencies" count={(detail.depends_on?.length || 0) + (detail.depended_on_by?.length || 0)}
              hint="Direction of reliance, not of the stored relationship: an instance names its
                    subnet, so removing the subnet is what would affect the instance.">
              <p className="px-3.5 pb-1.5 text-meta font-bold uppercase tracking-wider text-subtle">
                This depends on
              </p>
              <RelationshipList items={detail.depends_on} onSelect={onSelectNode} onExplain={onExplainEdge}
                emptyLabel="Nothing discovered that this resource relies on." />
              <p className="px-3.5 pb-1.5 pt-3 text-meta font-bold uppercase tracking-wider text-subtle">
                Depends on this
              </p>
              <RelationshipList items={detail.depended_on_by} onSelect={onSelectNode} onExplain={onExplainEdge}
                emptyLabel="Nothing discovered relies on this resource." />
              <div className="mt-3 px-3.5">
                <Button variant="secondary" size="sm" className="w-full" icon="alert"
                  onClick={() => onShowImpact?.(node.id)}>
                  Run impact analysis
                </Button>
              </div>
            </Section>

            {/* Why an expected relationship is missing. This is the honest
                counterpart to the edges we do draw. */}
            {detail.unresolved_references?.length > 0 && (
              <Section title="Unresolved references" count={detail.unresolved_references.length}
                hint="This resource names these identifiers, but no discovered resource matches
                      them — so the relationship is known and cannot be drawn.">
                <ul className="mx-3.5 flex flex-col gap-1.5">
                  {detail.unresolved_references.map((ref) => (
                    <li key={`${ref.field}-${ref.value}`} className="rounded-control border border-border bg-sunken p-2">
                      <p className="text-meta font-semibold text-fg">{ref.field}</p>
                      <p className="mt-0.5 break-all font-mono text-meta text-muted">{ref.value}</p>
                      <p className="mt-1 text-meta leading-relaxed text-subtle">{ref.explanation}</p>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section title="Provenance" defaultOpen={false}>
              <dl className="mx-3.5 divide-y divide-border overflow-hidden rounded-control border border-border">
                <Row label="Source" value={node.source} />
                <Row label="First discovered" value={formatMoment(node.discovered_at)} />
                <Row label="Last updated" value={formatMoment(node.updated_at)} />
                <Row label="Topology built" value={formatMoment(detail.topology_generated_at)} />
                <Row label="Connections" value={formatCount(detail.connection_count)} />
              </dl>
            </Section>
          </>
        )}

        {tab === 'relationships' && (
          <>
            <Section title="Inbound" count={structural(detail.inbound || []).length}>
              <RelationshipList items={structural(detail.inbound || [])} onSelect={onSelectNode}
                onExplain={onExplainEdge} emptyLabel="No inbound relationships discovered." />
            </Section>
            <Section title="Outbound" count={structural(detail.outbound || []).length}>
              <RelationshipList items={structural(detail.outbound || [])} onSelect={onSelectNode}
                onExplain={onExplainEdge} emptyLabel="No outbound relationships discovered." />
            </Section>
            <Section title="Permissions" count={permissions.length}
              hint="What this resource's identity is ALLOWED to reach. Not a record that any
                    access happened — that is the Event Log's job.">
              <RelationshipList items={permissions} onSelect={onSelectNode} onExplain={onExplainEdge}
                emptyLabel="No per-resource permission grants discovered." />
            </Section>
            <Section title="Data flow" count={dataflow.length}
              hint="Confirmed data movement or invocation only.">
              <RelationshipList items={dataflow} onSelect={onSelectNode} onExplain={onExplainEdge}
                emptyLabel="No data-flow relationships discovered." />
            </Section>
            <div className="p-3.5">
              <Button variant="secondary" size="sm" className="w-full" icon="route"
                onClick={() => onFindPathFrom?.(node.id)}>
                Find a path from this resource
              </Button>
            </div>
          </>
        )}

        {tab === 'config' && (
          <>
            {detail.redacted && (
              <div className="p-3.5 pb-0">
                <Notice tone="info" title="Some values are redacted">
                  Fields whose names or contents look like credentials — passwords, keys, tokens,
                  connection strings — are replaced before the configuration leaves the server.
                </Notice>
              </div>
            )}
            {Object.entries(CONFIG_SECTIONS).map(([key, section]) => {
              const table = <ConfigTable config={config} keys={section.keys} />;
              if (!table) return null;
              return (
                <Section key={key} title={section.title} defaultOpen={key === 'network' || key === 'security'}>
                  {table}
                </Section>
              );
            })}
            {otherConfig.length > 0 && (
              <Section title="Other configuration" count={otherConfig.length} defaultOpen={false}>
                <dl className="mx-3.5 divide-y divide-border overflow-hidden rounded-control border border-border">
                  {otherConfig.map(([key, value]) => (
                    <Row key={key} label={key.replace(/_/g, ' ')} value={value} />
                  ))}
                </dl>
              </Section>
            )}
            {Object.keys(metadata).length > 0 && (
              <Section title="Metadata" count={Object.keys(metadata).length} defaultOpen={false}>
                <dl className="mx-3.5 divide-y divide-border overflow-hidden rounded-control border border-border">
                  {Object.entries(metadata).map(([key, value]) => (
                    <Row key={key} label={key.replace(/_/g, ' ')} value={renderConfigValue(value)} />
                  ))}
                </dl>
              </Section>
            )}
            {Object.keys(detail.tags || {}).length > 0 && (
              <Section title="Tags" count={Object.keys(detail.tags).length} defaultOpen={false}>
                <div className="mx-3.5 flex flex-wrap gap-1">
                  {Object.entries(detail.tags).map(([key, value]) => (
                    <span key={key} className="rounded bg-sunken px-1.5 py-0.5 text-meta text-muted">
                      <span className="font-semibold">{key}</span>
                      {value ? `: ${value}` : ''}
                    </span>
                  ))}
                </div>
              </Section>
            )}
            {Object.keys(config).length === 0 && (
              <p className="p-3.5 text-[12px] italic text-subtle">
                No configuration was collected for this resource.
              </p>
            )}

            <Section title="Raw provider data" defaultOpen={false}
              hint="Exactly what the provider returned, unmodified apart from redaction. The
                    normalized view above is for the topology engine; this is for investigation.">
              {!canViewRaw ? (
                <p className="px-3.5 text-[12px] italic text-subtle">
                  Your role does not include permission to view raw provider payloads.
                </p>
              ) : !rawRequested ? (
                <div className="px-3.5">
                  <Button variant="secondary" size="sm" className="w-full" onClick={onRequestRaw}>
                    Load raw payload
                  </Button>
                </div>
              ) : detail.raw_data ? (
                <div className="px-3.5">
                  <div className="mb-1.5 flex justify-end gap-1.5">
                    <CopyButton text={JSON.stringify(detail.raw_data, null, 2)} label="Copy JSON" size="sm" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const blob = new Blob([JSON.stringify(detail.raw_data, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = `${node.name || 'resource'}.json`;
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      Download
                    </Button>
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-control border border-border bg-sunken p-2 font-mono text-meta leading-relaxed text-fg">
                    {JSON.stringify(detail.raw_data, null, 2)}
                  </pre>
                </div>
              ) : (
                <p className="px-3.5 text-[12px] italic text-subtle">
                  No raw payload was stored for this resource.
                </p>
              )}
            </Section>
          </>
        )}

        {tab === 'activity' && (
          <>
            <Section title="Configuration drift" count={node.drift_count || 0}
              hint="Field-level changes detected between discovery scans, from the append-only
                    change log.">
              {node.drift_count > 0 ? (
                <div className="mx-3.5 rounded-control border border-border bg-sunken p-2.5">
                  <p className="text-[12.5px] text-fg">
                    <strong>{formatCount(node.drift_count)}</strong> recorded change
                    {node.drift_count === 1 ? '' : 's'}
                    {node.significant_drift_count > 0 && (
                      <>, <strong>{node.significant_drift_count}</strong> at high or critical severity</>
                    )}
                    .
                  </p>
                  {node.last_drift_at && (
                    <p className="mt-1 text-meta text-muted">Most recent: {formatMoment(node.last_drift_at)}</p>
                  )}
                  <Button variant="secondary" size="sm" className="mt-2 w-full" iconRight="external"
                    onClick={() => onViewDrift?.(node)}>
                    View configuration drift
                  </Button>
                </div>
              ) : (
                <p className="px-3.5 text-[12px] italic text-subtle">
                  No configuration changes recorded for this resource.
                </p>
              )}
            </Section>

            <Section title="Audit events" count={node.event_count || 0}
              hint={`Control-plane activity touching this resource in the last ${node.event_window_days || 30} days.`}>
              {node.event_count > 0 ? (
                <div className="mx-3.5 rounded-control border border-border bg-sunken p-2.5">
                  <p className="text-[12.5px] text-fg">
                    <strong>{formatCount(node.event_count)}</strong> event
                    {node.event_count === 1 ? '' : 's'}
                    {node.high_risk_event_count > 0 && (
                      <>, <strong>{node.high_risk_event_count}</strong> at high or critical risk</>
                    )}
                    .
                  </p>
                  {node.last_event_at && (
                    <p className="mt-1 text-meta text-muted">Most recent: {formatMoment(node.last_event_at)}</p>
                  )}
                  <Button variant="secondary" size="sm" className="mt-2 w-full" iconRight="external"
                    onClick={() => onViewEvents?.(node)}>
                    View events — who changed this?
                  </Button>
                </div>
              ) : (
                <p className="px-3.5 text-[12px] italic text-subtle">
                  No audit events touching this resource in the last {node.event_window_days || 30} days.
                  {' '}
                  Absence here can also mean the provider&apos;s audit API is not being collected for
                  this account — check the Event Log&apos;s collection health.
                </p>
              )}
            </Section>
          </>
        )}
      </div>

      {!node.is_synthetic && (
        <footer className="shrink-0 border-t border-border p-3">
          <Button variant="primary" size="sm" className="w-full" iconRight="external"
            onClick={() => onOpenFullDetail?.(node.id)}>
            Open full resource page
          </Button>
        </footer>
      )}
    </aside>
  );
}
