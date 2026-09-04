"""Azure resource scanner — discovers VMs, SQL, Storage, AKS, App Services, VNets."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

from app.providers.azure.azure_auth import AzureAuth
from app.providers.scan_pool import scan_pool

logger = logging.getLogger("cloud_svc.azure.scanner")


# Friendly display names for common Azure resource types (lowercased keys).
# Anything not listed falls back to the last path segment, PascalCased.
_TYPE_MAP = {
    "microsoft.compute/virtualmachines": "VirtualMachine",
    "microsoft.compute/disks": "ManagedDisk",
    "microsoft.compute/virtualmachinescalesets": "VMScaleSet",
    "microsoft.compute/availabilitysets": "AvailabilitySet",
    "microsoft.compute/snapshots": "Snapshot",
    "microsoft.compute/images": "VMImage",
    "microsoft.storage/storageaccounts": "StorageAccount",
    "microsoft.sql/servers": "SQLServer",
    "microsoft.sql/servers/databases": "SQLDatabase",
    "microsoft.dbformysql/servers": "MySQLServer",
    "microsoft.dbformysql/flexibleservers": "MySQLServer",
    "microsoft.dbforpostgresql/servers": "PostgreSQLServer",
    "microsoft.dbforpostgresql/flexibleservers": "PostgreSQLServer",
    "microsoft.documentdb/databaseaccounts": "CosmosDB",
    "microsoft.cache/redis": "RedisCache",
    "microsoft.containerservice/managedclusters": "AKSCluster",
    "microsoft.containerregistry/registries": "ContainerRegistry",
    "microsoft.web/sites": "AppService",
    "microsoft.web/serverfarms": "AppServicePlan",
    "microsoft.web/staticsites": "StaticWebApp",
    "microsoft.keyvault/vaults": "KeyVault",
    "microsoft.network/virtualnetworks": "VirtualNetwork",
    "microsoft.network/networksecuritygroups": "NetworkSecurityGroup",
    "microsoft.network/publicipaddresses": "PublicIP",
    "microsoft.network/networkinterfaces": "NetworkInterface",
    "microsoft.network/loadbalancers": "LoadBalancer",
    "microsoft.network/applicationgateways": "ApplicationGateway",
    "microsoft.network/privateendpoints": "PrivateEndpoint",
    "microsoft.network/natgateways": "NATGateway",
    "microsoft.network/dnszones": "DNSZone",
    "microsoft.network/bastionhosts": "Bastion",
    "microsoft.network/routetables": "RouteTable",
    "microsoft.insights/components": "AppInsights",
    "microsoft.insights/actiongroups": "ActionGroup",
    "microsoft.operationalinsights/workspaces": "LogAnalytics",
    "microsoft.logic/workflows": "LogicApp",
    "microsoft.eventhub/namespaces": "EventHub",
    "microsoft.servicebus/namespaces": "ServiceBus",
    "microsoft.apimanagement/service": "APIManagement",
    "microsoft.cdn/profiles": "CDNProfile",
    "microsoft.managedidentity/userassignedidentities": "ManagedIdentity",
    "microsoft.recoveryservices/vaults": "RecoveryVault",
}


def _friendly_type(azure_type: str) -> str:
    """Map an Azure ARM type string to a short, UI-friendly resource type."""
    if not azure_type:
        return "Unknown"
    key = azure_type.lower()
    if key in _TYPE_MAP:
        return _TYPE_MAP[key]
    seg = azure_type.split("/")[-1]
    return (seg[:1].upper() + seg[1:]) if seg else azure_type


def _resource_group_of(resource_id: str | None) -> str | None:
    if not resource_id or "/resourceGroups/" not in resource_id:
        return None
    try:
        return resource_id.split("/resourceGroups/")[1].split("/")[0]
    except (IndexError, AttributeError):
        return None


class AzureScanner:
    def __init__(self, auth: AzureAuth) -> None:
        self.auth = auth
        # Scopes that failed to enumerate this run. Non-empty means the sweep
        # is INCOMPLETE and must not be pruned against (see BaseCloudProvider).
        self.scan_failures: list[str] = []

    @staticmethod
    def _vm_power_state(compute, vm_resource_id: str) -> str | None:
        """Real power state (VM running/stopped/deallocated) for an ARM VM
        resource ID. provisioning_state only reflects the last ARM operation
        (e.g. 'Succeeded'), not whether the VM is actually on — this requires
        the separate instanceView call. Best-effort: any failure leaves None."""
        try:
            rg = vm_resource_id.split("/resourceGroups/")[1].split("/")[0]
            vm_name = vm_resource_id.split("/")[-1]
            iv = compute.virtual_machines.instance_view(rg, vm_name)
            return next(
                (s.display_status for s in (iv.statuses or [])
                 if s.code and s.code.startswith("PowerState/")),
                None,
            )
        except Exception:
            return None

    # ── Virtual Machines ─────────────────────────────────────────────────────
    async def _scan_vms(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.compute import ComputeManagementClient
            from azure.mgmt.network import NetworkManagementClient

            compute = self.auth.get_client(ComputeManagementClient)
            net = self.auth.get_client(NetworkManagementClient)
            results = []
            for vm in compute.virtual_machines.list_all():
                location = vm.location or "unknown"
                power_state = self._vm_power_state(compute, vm.id)
                # Try to get public IP if available
                ip = None
                try:
                    nic_ref = (
                        vm.network_profile.network_interfaces[0].id
                        if vm.network_profile
                        else None
                    )
                    if nic_ref:
                        rg = nic_ref.split("/resourceGroups/")[1].split("/")[0]
                        nic_name = nic_ref.split("/")[-1]
                        nic = net.network_interfaces.get(rg, nic_name)
                        if nic.ip_configurations:
                            pip_ref = nic.ip_configurations[0].public_ip_address
                            if pip_ref:
                                pip_name = pip_ref.id.split("/")[-1]
                                pip_rg = pip_ref.id.split("/resourceGroups/")[1].split("/")[0]
                                pip = net.public_ip_addresses.get(pip_rg, pip_name)
                                ip = pip.ip_address
                except Exception:
                    pass

                tags = vm.tags or {}
                results.append(
                    {
                        "provider_resource_id": vm.id,
                        "resource_type": "VirtualMachine",
                        "resource_name": vm.name,
                        "region_or_zone": location,
                        "status": vm.provisioning_state,
                        "ip_address": ip,
                        "config": {
                            "vm_size": (
                                vm.hardware_profile.vm_size
                                if vm.hardware_profile
                                else None
                            ),
                            "os_type": (
                                getattr(vm.storage_profile.os_disk.os_type, "value", None)
                                if vm.storage_profile
                                and vm.storage_profile.os_disk
                                else None
                            ),
                            "power_state": power_state,
                            # Everything this VM is wired to. ARM gives these as
                            # full resource IDs on the VM model, so they resolve
                            # exactly — no name matching.
                            "nic_ids": [
                                n.id for n in (vm.network_profile.network_interfaces or [])
                                if getattr(n, "id", None)
                            ] if vm.network_profile else [],
                            "os_disk_id": (
                                vm.storage_profile.os_disk.managed_disk.id
                                if vm.storage_profile and vm.storage_profile.os_disk
                                and vm.storage_profile.os_disk.managed_disk
                                else None
                            ),
                            "data_disk_ids": [
                                d.managed_disk.id
                                for d in (vm.storage_profile.data_disks or [])
                                if getattr(d, "managed_disk", None)
                                and getattr(d.managed_disk, "id", None)
                            ] if vm.storage_profile else [],
                            "availability_set_id": (
                                vm.availability_set.id if vm.availability_set else None
                            ),
                            "identity_id": (
                                getattr(vm.identity, "principal_id", None)
                                if getattr(vm, "identity", None) else None
                            ),
                        },
                        "metadata": {
                            "resource_group": vm.id.split("/resourceGroups/")[1].split("/")[0]
                            if vm.id
                            else None,
                        },
                        "cost_monthly": None,
                        "tags": tags,
                        "raw_data": {"id": vm.id, "name": vm.name, "location": location},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Managed Disks ────────────────────────────────────────────────────────
    async def _scan_disks(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.compute import ComputeManagementClient

            compute = self.auth.get_client(ComputeManagementClient)
            disks = list(compute.disks.list())

            # Resolve power state for each distinct VM a disk is attached to, so
            # a disk attached to a STOPPED/deallocated VM can be flagged as still
            # billing while idle. Best-effort: any failure just leaves it None.
            attached_vm_ids = {d.managed_by for d in disks if d.managed_by}
            vm_power_state: Dict[str, str | None] = {
                vm_id: self._vm_power_state(compute, vm_id) for vm_id in attached_vm_ids
            }

            results = []
            for disk in disks:
                managed_by = disk.managed_by
                results.append(
                    {
                        "provider_resource_id": disk.id,
                        "resource_type": "ManagedDisk",
                        "resource_name": disk.name,
                        "region_or_zone": disk.location,
                        "status": disk.provisioning_state,
                        "ip_address": None,
                        "config": {
                            "disk_size_gb": disk.disk_size_gb,
                            "sku": disk.sku.name if disk.sku else None,
                            "os_type": getattr(disk.os_type, "value", None) if disk.os_type else None,
                            # disk_state is Azure's own attachment field: Attached,
                            # Unattached, Reserved, ActiveSAS, ActiveUpload, etc.
                            "disk_state": getattr(disk, "disk_state", None),
                            "attachment_status": "Attached" if managed_by else "Unattached",
                            "attached_to_id": managed_by,
                            "attached_to_name": managed_by.split("/")[-1] if managed_by else None,
                            "attached_to_status": vm_power_state.get(managed_by) if managed_by else None,
                        },
                        "metadata": {"resource_group": _resource_group_of(disk.id)},
                        "cost_monthly": None,
                        "tags": disk.tags or {},
                        "raw_data": {"id": disk.id, "name": disk.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Storage Accounts ─────────────────────────────────────────────────────
    async def _scan_storage(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.storage import StorageManagementClient

            storage = self.auth.get_client(StorageManagementClient)
            results = []
            for acc in storage.storage_accounts.list():
                results.append(
                    {
                        "provider_resource_id": acc.id,
                        "resource_type": "StorageAccount",
                        "resource_name": acc.name,
                        "region_or_zone": acc.location,
                        "status": acc.provisioning_state,
                        "ip_address": acc.primary_endpoints.blob if acc.primary_endpoints else None,
                        "config": {
                            "sku": acc.sku.name if acc.sku else None,
                            "kind": acc.kind,
                            "access_tier": acc.access_tier,
                            # Real setting from the API; None = not reported
                            "allow_blob_public_access": getattr(acc, "allow_blob_public_access", None),
                        },
                        "metadata": {},
                        "cost_monthly": None,
                        "tags": acc.tags or {},
                        "raw_data": {"id": acc.id, "name": acc.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── SQL Databases ────────────────────────────────────────────────────────
    async def _scan_sql(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.sql import SqlManagementClient

            sql = self.auth.get_client(SqlManagementClient)
            results = []
            for server in sql.servers.list():
                rg = server.id.split("/resourceGroups/")[1].split("/")[0]
                for db in sql.databases.list_by_server(rg, server.name):
                    if db.name == "master":
                        continue
                    results.append(
                        {
                            "provider_resource_id": db.id,
                            "resource_type": "SQLDatabase",
                            "resource_name": db.name,
                            "region_or_zone": db.location,
                            "status": db.status,
                            "ip_address": server.fully_qualified_domain_name,
                            "config": {
                                "sku": db.sku.name if db.sku else None,
                                "edition": db.edition if hasattr(db, "edition") else None,
                                "max_size_bytes": db.max_size_bytes,
                            },
                            "metadata": {
                                "server": server.name,
                                "collation": db.collation,
                            },
                            "cost_monthly": None,
                            "tags": db.tags or {},
                            "raw_data": {"id": db.id, "name": db.name},
                        }
                    )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── PostgreSQL / MySQL Flexible Servers ──────────────────────────────────
    # The generic ARM sweep already discovers these (as PostgreSQLServer /
    # MySQLServer via _TYPE_MAP), so they were never invisible to inventory or
    # cost matching — but the sweep gives every resource the same
    # {sku, kind, azure_type} stub regardless of type, with no version, storage
    # size, HA config, or public-network-access flag. That last one especially
    # is a real security signal (an internet-reachable managed database) this
    # service otherwise has no way to check. Dedicated scanners here enrich
    # the SAME provider_resource_id the sweep already uses, so upsert_resources
    # replaces the stub with the richer row rather than duplicating it.
    async def _scan_postgresql(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.rdbms.postgresql_flexibleservers import PostgreSQLManagementClient

            client = self.auth.get_client(PostgreSQLManagementClient)
            results = []
            for s in client.servers.list():
                ha = getattr(s, "high_availability", None)
                net = getattr(s, "network", None)
                backup = getattr(s, "backup", None)
                results.append(
                    {
                        "provider_resource_id": s.id,
                        "resource_type": "PostgreSQLServer",
                        "resource_name": s.name,
                        "region_or_zone": s.location,
                        "status": s.state,
                        "ip_address": s.fully_qualified_domain_name,
                        "config": {
                            "sku": s.sku.name if s.sku else None,
                            "tier": s.sku.tier if s.sku else None,
                            "version": s.version,
                            "storage_gb": getattr(s.storage, "storage_size_gb", None) if s.storage else None,
                            "public_network_access": getattr(net, "public_network_access", None),
                            "high_availability_mode": getattr(ha, "mode", None),
                            "geo_redundant_backup": getattr(backup, "geo_redundant_backup", None),
                            "backup_retention_days": getattr(backup, "backup_retention_days", None),
                            "availability_zone": s.availability_zone,
                        },
                        "metadata": {
                            "resource_group": _resource_group_of(s.id),
                            "administrator_login": s.administrator_login,
                        },
                        "cost_monthly": None,
                        "tags": s.tags or {},
                        "raw_data": {"id": s.id, "name": s.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    async def _scan_mysql(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.rdbms.mysql_flexibleservers import MySQLManagementClient

            client = self.auth.get_client(MySQLManagementClient)
            results = []
            for s in client.servers.list():
                ha = getattr(s, "high_availability", None)
                net = getattr(s, "network", None)
                backup = getattr(s, "backup", None)
                results.append(
                    {
                        "provider_resource_id": s.id,
                        "resource_type": "MySQLServer",
                        "resource_name": s.name,
                        "region_or_zone": s.location,
                        "status": s.state,
                        "ip_address": s.fully_qualified_domain_name,
                        "config": {
                            "sku": s.sku.name if s.sku else None,
                            "tier": s.sku.tier if s.sku else None,
                            "version": s.version,
                            "storage_gb": getattr(s.storage, "storage_size_gb", None) if s.storage else None,
                            "public_network_access": getattr(net, "public_network_access", None),
                            "high_availability_mode": getattr(ha, "mode", None),
                            "geo_redundant_backup": getattr(backup, "geo_redundant_backup", None),
                            "backup_retention_days": getattr(backup, "backup_retention_days", None),
                            "availability_zone": s.availability_zone,
                        },
                        "metadata": {
                            "resource_group": _resource_group_of(s.id),
                            "administrator_login": s.administrator_login,
                        },
                        "cost_monthly": None,
                        "tags": s.tags or {},
                        "raw_data": {"id": s.id, "name": s.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Cosmos DB ─────────────────────────────────────────────────────────────
    async def _scan_cosmosdb(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.cosmosdb import CosmosDBManagementClient

            client = self.auth.get_client(CosmosDBManagementClient)
            results = []
            for acct in client.database_accounts.list():
                # Unlike SQL/AKS/older Azure SDKs, this generation of
                # azure-mgmt-cosmosdb does NOT flatten `properties.*` onto the
                # top-level resource object — id/name/location/kind/tags are
                # top-level, but provisioning_state, document_endpoint,
                # public_network_access etc. all live one level down, under
                # `.properties`. Accessing them directly on `acct` raises
                # AttributeError.
                props = acct.properties
                capabilities = [c.name for c in (props.capabilities or [])] if props else []
                consistency = props.consistency_policy if props else None
                results.append(
                    {
                        "provider_resource_id": acct.id,
                        "resource_type": "CosmosDB",
                        "resource_name": acct.name,
                        "region_or_zone": acct.location,
                        "status": props.provisioning_state if props else None,
                        "ip_address": props.document_endpoint if props else None,
                        "config": {
                            "kind": acct.kind,
                            "consistency_level": consistency.default_consistency_level if consistency else None,
                            "public_network_access": props.public_network_access if props else None,
                            "is_virtual_network_filter_enabled": (
                                props.is_virtual_network_filter_enabled if props else None
                            ),
                            "enable_multiple_write_locations": (
                                props.enable_multiple_write_locations if props else None
                            ),
                            "serverless": "EnableServerless" in capabilities,
                            "capabilities": capabilities,
                            "read_region_count": len(props.read_locations or []) if props else 0,
                        },
                        "metadata": {"resource_group": _resource_group_of(acct.id)},
                        "cost_monthly": None,
                        "tags": acct.tags or {},
                        "raw_data": {"id": acct.id, "name": acct.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Azure Cache for Redis ─────────────────────────────────────────────────
    async def _scan_redis(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.redis import RedisManagementClient

            client = self.auth.get_client(RedisManagementClient)
            results = []
            for r in client.redis.list_by_subscription():
                results.append(
                    {
                        "provider_resource_id": r.id,
                        "resource_type": "RedisCache",
                        "resource_name": r.name,
                        "region_or_zone": r.location,
                        "status": r.provisioning_state,
                        "ip_address": r.host_name,
                        "config": {
                            "sku": r.sku.name if r.sku else None,
                            "family": r.sku.family if r.sku else None,
                            "capacity": r.sku.capacity if r.sku else None,
                            "redis_version": r.redis_version,
                            "public_network_access": r.public_network_access,
                            "ssl_port": r.ssl_port,
                            "non_ssl_port_enabled": r.enable_non_ssl_port,
                        },
                        "metadata": {"resource_group": _resource_group_of(r.id)},
                        "cost_monthly": None,
                        "tags": r.tags or {},
                        "raw_data": {"id": r.id, "name": r.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── AKS Clusters ─────────────────────────────────────────────────────────
    async def _scan_aks(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.containerservice import ContainerServiceClient

            aks = self.auth.get_client(ContainerServiceClient)
            results = []
            for cluster in aks.managed_clusters.list():
                results.append(
                    {
                        "provider_resource_id": cluster.id,
                        "resource_type": "AKSCluster",
                        "resource_name": cluster.name,
                        "region_or_zone": cluster.location,
                        "status": cluster.provisioning_state,
                        "ip_address": None,
                        "config": {
                            "kubernetes_version": cluster.kubernetes_version,
                            "node_count": sum(
                                p.count or 0
                                for p in (cluster.agent_pool_profiles or [])
                            ),
                        },
                        "metadata": {},
                        "cost_monthly": None,
                        "tags": cluster.tags or {},
                        "raw_data": {"id": cluster.id, "name": cluster.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Generic catch-all (every resource type via ARM resources.list) ───────
    async def _scan_network(self) -> List[Dict[str, Any]]:
        """Network interfaces, subnets and public-IP associations.

        Azure hangs its whole network topology off the NIC: the NIC is what knows
        the VM, the subnet, the NSG and the public IP. The generic ARM listing
        returns NICs as flat rows with none of that, so VMs, subnets, NSGs and
        public IPs all sat unconnected. Subnets are worse than unconnected —
        `resources.list()` does not return them at all, because they are
        sub-resources of a VNet.

        Everything here is read from the ARM models as full resource IDs, so the
        topology resolves them exactly rather than by name.
        """
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.network import NetworkManagementClient

            net = self.auth.get_client(NetworkManagementClient)
            results: List[Dict[str, Any]] = []

            # ── Subnets (as children of each VNet) ───────────────────────────
            try:
                for vnet in net.virtual_networks.list_all():
                    for sn in (vnet.subnets or []):
                        results.append({
                            "provider_resource_id": sn.id,
                            "resource_type": "Subnet",
                            "resource_name": sn.name,
                            "region_or_zone": vnet.location or "global",
                            "status": sn.provisioning_state,
                            "ip_address": sn.address_prefix,
                            "config": {
                                "address_prefix": sn.address_prefix,
                                "virtual_network_id": vnet.id,
                                "network_security_group_id": (
                                    sn.network_security_group.id
                                    if sn.network_security_group else None
                                ),
                                "route_table_id": (
                                    sn.route_table.id if sn.route_table else None
                                ),
                                "nat_gateway_id": (
                                    sn.nat_gateway.id if getattr(sn, "nat_gateway", None) else None
                                ),
                            },
                            "metadata": {"resource_group": _resource_group_of(sn.id)},
                            "cost_monthly": None,
                            "tags": {},
                            "raw_data": {"id": sn.id, "name": sn.name},
                        })
            except Exception as exc:
                self.scan_failures.append(f"Subnet: {str(exc)[:160]}")

            # ── Network interfaces ───────────────────────────────────────────
            try:
                for nic in net.network_interfaces.list_all():
                    subnet_ids, pip_ids, private_ips = [], [], []
                    for cfg in (nic.ip_configurations or []):
                        if getattr(cfg, "subnet", None) and cfg.subnet.id:
                            subnet_ids.append(cfg.subnet.id)
                        if getattr(cfg, "public_ip_address", None) and cfg.public_ip_address.id:
                            pip_ids.append(cfg.public_ip_address.id)
                        if getattr(cfg, "private_ip_address", None):
                            private_ips.append(cfg.private_ip_address)
                    results.append({
                        "provider_resource_id": nic.id,
                        "resource_type": "NetworkInterface",
                        "resource_name": nic.name,
                        "region_or_zone": nic.location or "global",
                        "status": nic.provisioning_state,
                        "ip_address": private_ips[0] if private_ips else None,
                        "config": {
                            # The VM this NIC is plugged into.
                            "attached_to_id": (
                                nic.virtual_machine.id if nic.virtual_machine else None
                            ),
                            "attachment_status": "Attached" if nic.virtual_machine else "Unattached",
                            "subnet_ids": subnet_ids,
                            "public_ip_ids": pip_ids,
                            "network_security_group_id": (
                                nic.network_security_group.id
                                if nic.network_security_group else None
                            ),
                            "private_ip": private_ips[0] if private_ips else None,
                            "accelerated_networking": nic.enable_accelerated_networking,
                        },
                        "metadata": {"resource_group": _resource_group_of(nic.id)},
                        "cost_monthly": None,
                        "tags": nic.tags or {},
                        "raw_data": {"id": nic.id, "name": nic.name},
                    })
            except Exception as exc:
                self.scan_failures.append(f"NetworkInterface: {str(exc)[:160]}")

            # ── Public IPs (with the address, which the generic sweep omits) ──
            try:
                for pip in net.public_ip_addresses.list_all():
                    results.append({
                        "provider_resource_id": pip.id,
                        "resource_type": "PublicIP",
                        "resource_name": pip.name,
                        "region_or_zone": pip.location or "global",
                        "status": pip.provisioning_state,
                        "ip_address": pip.ip_address,
                        "config": {
                            "allocation_method": getattr(
                                pip.public_ip_allocation_method, "value",
                                pip.public_ip_allocation_method),
                            "sku": pip.sku.name if pip.sku else None,
                            # What it is bound to (a NIC ip-config, an LB, a gateway).
                            "attached_to_id": (
                                pip.ip_configuration.id if pip.ip_configuration else None
                            ),
                            "fqdn": (
                                pip.dns_settings.fqdn if pip.dns_settings else None
                            ),
                        },
                        "metadata": {"resource_group": _resource_group_of(pip.id)},
                        "cost_monthly": None,
                        "tags": pip.tags or {},
                        "raw_data": {"id": pip.id, "name": pip.name},
                    })
            except Exception as exc:
                self.scan_failures.append(f"PublicIP: {str(exc)[:160]}")

            # ── Network Security Groups, with their actual rules ─────────────
            # The generic ARM sweep returns an NSG as a bare row with only
            # {azure_type, sku, kind} — none of which is a rule. Without this,
            # internet-exposure analysis had no way to know what an Azure NSG
            # actually allows.
            try:
                for nsg in net.network_security_groups.list_all():
                    rules = [
                        {
                            "priority": r.priority,
                            "direction": r.direction,        # Inbound | Outbound
                            "access": r.access,               # Allow | Deny
                            "protocol": r.protocol,           # Tcp | Udp | * | ...
                            "source_address_prefix": r.source_address_prefix,
                            "destination_port_range": r.destination_port_range,
                            "destination_port_ranges": r.destination_port_ranges or [],
                        }
                        # Effective security rules include the platform defaults
                        # (AllowVnetInBound, DenyAllInBound, ...); without them a
                        # gap in the custom rules silently reads as "no rule",
                        # when Azure's own default is actually to deny.
                        for r in (nsg.security_rules or []) + (nsg.default_security_rules or [])
                    ]
                    results.append({
                        "provider_resource_id": nsg.id,
                        "resource_type": "NetworkSecurityGroup",
                        "resource_name": nsg.name,
                        "region_or_zone": nsg.location or "global",
                        "status": nsg.provisioning_state,
                        "ip_address": None,
                        "config": {
                            "ingress_rules": [r for r in rules if r["direction"] == "Inbound"],
                            "egress_rules": [r for r in rules if r["direction"] == "Outbound"],
                        },
                        "metadata": {"resource_group": _resource_group_of(nsg.id)},
                        "cost_monthly": None,
                        "tags": nsg.tags or {},
                        "raw_data": {"id": nsg.id, "name": nsg.name},
                    })
            except Exception as exc:
                self.scan_failures.append(f"NetworkSecurityGroup: {str(exc)[:160]}")

            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    async def _scan_generic(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            client = self.auth.get_resource_client()
            results = []
            # $expand=provisioningState returns the real ARM provisioning state
            for res in client.resources.list(expand="provisioningState"):
                results.append(
                    {
                        "provider_resource_id": res.id,
                        "resource_type": _friendly_type(res.type or ""),
                        "resource_name": res.name,
                        "region_or_zone": res.location or "global",
                        "status": getattr(res, "provisioning_state", None),
                        "ip_address": None,
                        "config": {
                            "azure_type": res.type,
                            "sku": res.sku.name if res.sku else None,
                            "kind": res.kind,
                            # ARM reports the resource that owns this one's
                            # lifecycle (a disk's VM, anything a scale set
                            # created). It costs nothing extra here and is a real
                            # relationship the graph had no other way to know.
                            "managed_by": getattr(res, "managed_by", None),
                        },
                        "metadata": {"resource_group": _resource_group_of(res.id)},
                        "cost_monthly": None,
                        "tags": res.tags or {},
                        "raw_data": {"id": res.id, "name": res.name, "type": res.type},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    async def scan_all(self, on_batch=None) -> List[Dict[str, Any]]:
        all_resources: List[Dict[str, Any]] = []
        permission_errors = []
        self.scan_failures = []

        async def _emit(batch):
            if batch and on_batch:
                try:
                    await on_batch(batch)
                except Exception as cb_exc:
                    logger.warning("Azure on_batch callback failed: %s", cb_exc)

        # Detailed scanners run first — they enrich specific types with data the
        # generic ARM listing can't provide (VM public IPs, storage SKUs, SQL DBs
        # which are sub-resources not returned by resources.list()).
        for scanner_fn, label in [
            (self._scan_vms, "VMs"),
            (self._scan_disks, "Disks"),
            (self._scan_storage, "Storage"),
            (self._scan_sql, "SQL"),
            (self._scan_postgresql, "PostgreSQL"),
            (self._scan_mysql, "MySQL"),
            (self._scan_cosmosdb, "CosmosDB"),
            (self._scan_redis, "Redis"),
            (self._scan_aks, "AKS"),
            (self._scan_network, "Network"),
        ]:
            try:
                results = await scanner_fn()
                all_resources.extend(results)
                logger.info("Azure %s: found %d resources", label, len(results))
                await _emit(results)
            except Exception as exc:
                logger.warning("Azure %s scan failed: %s", label, exc)
                self.scan_failures.append(f"{label}: {str(exc)[:160]}")
                if "AuthorizationFailed" in str(exc) or "forbidden" in str(exc).lower():
                    permission_errors.append(str(exc))

        # Generic catch-all — captures every OTHER resource type in the
        # subscription (App Services, Key Vaults, Cosmos DB, VNets, NSGs, disks…).
        # Dedupe against the detailed results so enriched records win.
        seen_ids = {r["provider_resource_id"] for r in all_resources}
        try:
            generic = await self._scan_generic()
            added = 0
            new_batch = []
            for r in generic:
                if r["provider_resource_id"] not in seen_ids:
                    all_resources.append(r)
                    seen_ids.add(r["provider_resource_id"])
                    new_batch.append(r)
                    added += 1
            logger.info("Azure Generic: found %d resources (%d new)", len(generic), added)
            await _emit(new_batch)
        except Exception as exc:
            logger.warning("Azure generic scan failed: %s", exc)
            # The generic ARM sweep is the only source for most resource types,
            # so losing it makes the whole result unrepresentative.
            self.scan_failures.append(f"Generic ARM sweep: {str(exc)[:160]}")
            if "AuthorizationFailed" in str(exc) or "forbidden" in str(exc).lower():
                permission_errors.append(str(exc))

        if len(all_resources) == 0 and len(permission_errors) > 0:
            raise PermissionError("Missing required Azure IAM permissions (Reader). Azure returned AuthorizationFailed during the scan.")

        return all_resources
