"""Azure resource scanner — discovers VMs, SQL, Storage, AKS, App Services, VNets."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

from app.providers.azure.azure_auth import AzureAuth

logger = logging.getLogger("cloud_svc.azure.scanner")


class AzureScanner:
    def __init__(self, auth: AzureAuth) -> None:
        self.auth = auth

    # ── Virtual Machines ─────────────────────────────────────────────────────
    async def _scan_vms(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            from azure.mgmt.compute import ComputeManagementClient

            compute = ComputeManagementClient(
                self.auth.get_credential(), self.auth.subscription_id
            )
            results = []
            for vm in compute.virtual_machines.list_all():
                location = vm.location or "unknown"
                # Try to get public IP if available
                ip = None
                try:
                    from azure.mgmt.network import NetworkManagementClient

                    net = NetworkManagementClient(
                        self.auth.get_credential(), self.auth.subscription_id
                    )
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
                                vm.storage_profile.os_disk.os_type.value
                                if vm.storage_profile
                                and vm.storage_profile.os_disk
                                else None
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

    async def scan_all(self) -> List[Dict[str, Any]]:
        all_resources: List[Dict[str, Any]] = []
        permission_errors = []
        for scanner_fn, label in [
            (self._scan_vms, "VMs"),
            (self._scan_storage, "Storage"),
            (self._scan_sql, "SQL"),
            (self._scan_aks, "AKS"),
        ]:
            try:
                results = await scanner_fn()
                all_resources.extend(results)
                logger.info("Azure %s: found %d resources", label, len(results))
            except Exception as exc:
                logger.warning("Azure %s scan failed: %s", label, exc)
                if "AuthorizationFailed" in str(exc) or "forbidden" in str(exc).lower():
                    permission_errors.append(str(exc))
        
        if len(all_resources) == 0 and len(permission_errors) > 0:
            raise PermissionError("Missing required Azure IAM permissions (Reader). Azure returned AuthorizationFailed during the scan.")
            
        return all_resources
