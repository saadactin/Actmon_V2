"""Azure resource scanner — discovers VMs, SQL, Storage, AKS, App Services, VNets."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

from app.providers.azure.azure_auth import AzureAuth

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

            compute = ComputeManagementClient(
                self.auth.get_credential(), self.auth.subscription_id
            )
            net = NetworkManagementClient(
                self.auth.get_credential(), self.auth.subscription_id
            )
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

        return await loop.run_in_executor(None, _fetch)

    # ── Managed Disks ────────────────────────────────────────────────────────
    async def _scan_disks(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.compute import ComputeManagementClient

            compute = ComputeManagementClient(
                self.auth.get_credential(), self.auth.subscription_id
            )
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

        return await loop.run_in_executor(None, _fetch)

    # ── Storage Accounts ─────────────────────────────────────────────────────
    async def _scan_storage(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.storage import StorageManagementClient

            storage = StorageManagementClient(
                self.auth.get_credential(), self.auth.subscription_id
            )
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

        return await loop.run_in_executor(None, _fetch)

    # ── SQL Databases ────────────────────────────────────────────────────────
    async def _scan_sql(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.sql import SqlManagementClient

            sql = SqlManagementClient(self.auth.get_credential(), self.auth.subscription_id)
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

        return await loop.run_in_executor(None, _fetch)

    # ── AKS Clusters ─────────────────────────────────────────────────────────
    async def _scan_aks(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.containerservice import ContainerServiceClient

            aks = ContainerServiceClient(self.auth.get_credential(), self.auth.subscription_id)
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

        return await loop.run_in_executor(None, _fetch)

    # ── Generic catch-all (every resource type via ARM resources.list) ───────
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
                        },
                        "metadata": {"resource_group": _resource_group_of(res.id)},
                        "cost_monthly": None,
                        "tags": res.tags or {},
                        "raw_data": {"id": res.id, "name": res.name, "type": res.type},
                    }
                )
            return results

        return await loop.run_in_executor(None, _fetch)

    async def scan_all(self, on_batch=None) -> List[Dict[str, Any]]:
        all_resources: List[Dict[str, Any]] = []
        permission_errors = []

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
            (self._scan_aks, "AKS"),
        ]:
            try:
                results = await scanner_fn()
                all_resources.extend(results)
                logger.info("Azure %s: found %d resources", label, len(results))
                await _emit(results)
            except Exception as exc:
                logger.warning("Azure %s scan failed: %s", label, exc)
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
            if "AuthorizationFailed" in str(exc) or "forbidden" in str(exc).lower():
                permission_errors.append(str(exc))

        if len(all_resources) == 0 and len(permission_errors) > 0:
            raise PermissionError("Missing required Azure IAM permissions (Reader). Azure returned AuthorizationFailed during the scan.")

        return all_resources
