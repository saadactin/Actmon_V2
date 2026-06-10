"""
Azure Comprehensive Discovery Engine
Deep-dive analysis of Azure resources
"""

from azure.identity import ClientSecretCredential
from azure.mgmt.compute import ComputeManagementClient
from azure.mgmt.storage import StorageManagementClient
from azure.mgmt.sql import SqlManagementClient
from azure.mgmt.resource import ResourceManagementClient
from azure.mgmt.network import NetworkManagementClient
from azure.core.exceptions import AzureError
from typing import Dict, List, Any
import logging
from cloud.core.base_discovery import BaseCloudDiscovery

logger = logging.getLogger(__name__)


class AzureDiscovery(BaseCloudDiscovery):
    """Comprehensive Azure resource discovery"""

    def __init__(self, account_config: Dict[str, Any]):
        super().__init__(account_config)
        self.tenant_id = account_config.get("azure_tenant_id")
        self.client_id = account_config.get("azure_client_id")
        self.client_secret = account_config.get("azure_client_secret")
        self.subscription_id = account_config.get("azure_subscription_id")
        self.credential = None
        self.clients = {}

    def authenticate(self) -> bool:
        """Authenticate with Azure"""
        try:
            self.credential = ClientSecretCredential(
                tenant_id=self.tenant_id,
                client_id=self.client_id,
                client_secret=self.client_secret,
            )

            # Test authentication
            resource_client = ResourceManagementClient(
                self.credential, self.subscription_id
            )
            list(resource_client.resource_groups.list())
            logger.info(f"✅ Azure Authentication successful: {self.subscription_id}")
            return True

        except AzureError as e:
            logger.error(f"❌ Azure Authentication failed: {e}")
            return False

    def get_compute_client(self):
        """Get Azure Compute Management Client"""
        if "compute" not in self.clients:
            self.clients["compute"] = ComputeManagementClient(
                self.credential, self.subscription_id
            )
        return self.clients["compute"]

    def get_storage_client(self):
        """Get Azure Storage Management Client"""
        if "storage" not in self.clients:
            self.clients["storage"] = StorageManagementClient(
                self.credential, self.subscription_id
            )
        return self.clients["storage"]

    def get_sql_client(self):
        """Get Azure SQL Management Client"""
        if "sql" not in self.clients:
            self.clients["sql"] = SqlManagementClient(
                self.credential, self.subscription_id
            )
        return self.clients["sql"]

    def get_network_client(self):
        """Get Azure Network Management Client"""
        if "network" not in self.clients:
            self.clients["network"] = NetworkManagementClient(
                self.credential, self.subscription_id
            )
        return self.clients["network"]

    def discover_virtual_machines(self) -> List[Dict[str, Any]]:
        """Discover Azure Virtual Machines"""
        resources = []
        try:
            compute_client = self.get_compute_client()
            vms = compute_client.virtual_machines.list_all()

            for vm in vms:
                vm_name = vm.name
                resource_group = vm.id.split("/")[4]

                # Get instance view for status
                try:
                    instance_view = compute_client.virtual_machines.instance_view(
                        resource_group, vm_name
                    )
                    statuses = instance_view.statuses
                    power_state = next(
                        (s.display_status for s in statuses if "PowerState" in s.code),
                        "Unknown",
                    )
                except:
                    power_state = "Unknown"

                metadata = {
                    "vm_size": vm.hardware_profile.vm_size,
                    "os_type": vm.storage_profile.os_disk.os_type.value
                    if vm.storage_profile.os_disk.os_type
                    else "Unknown",
                    "location": vm.location,
                    "resource_group": resource_group,
                    "tags": vm.tags or {},
                    "power_state": power_state,
                }

                resources.append(
                    self.format_resource(
                        resource_id=vm.id,
                        resource_name=vm_name,
                        resource_type="Azure Virtual Machine",
                        region=vm.location,
                        status=power_state,
                        ip_address=None,
                        metadata=metadata,
                    )
                )

            self.log_discovery("Azure Virtual Machines", len(resources))
        except AzureError as e:
            logger.error(f"Error discovering Azure VMs: {e}")

        return resources

    def discover_storage_accounts(self) -> List[Dict[str, Any]]:
        """Discover Azure Storage Accounts"""
        resources = []
        try:
            storage_client = self.get_storage_client()
            accounts = storage_client.storage_accounts.list()

            for account in accounts:
                account_name = account.name
                resource_group = account.id.split("/")[4]

                metadata = {
                    "sku": account.sku.name if account.sku else "Unknown",
                    "kind": account.kind.value if account.kind else "Unknown",
                    "location": account.location,
                    "resource_group": resource_group,
                    "primary_endpoints": {
                        "blob": account.primary_endpoints.blob
                        if account.primary_endpoints
                        else None,
                    },
                    "encryption_enabled": bool(account.encryption),
                }

                resources.append(
                    self.format_resource(
                        resource_id=account.id,
                        resource_name=account_name,
                        resource_type="Azure Storage Account",
                        region=account.location,
                        status="Active",
                        ip_address=None,
                        metadata=metadata,
                    )
                )

            self.log_discovery("Azure Storage Accounts", len(resources))
        except AzureError as e:
            logger.error(f"Error discovering Azure Storage Accounts: {e}")

        return resources

    def discover_sql_databases(self) -> List[Dict[str, Any]]:
        """Discover Azure SQL Databases"""
        resources = []
        try:
            sql_client = self.get_sql_client()
            servers = sql_client.servers.list()

            for server in servers:
                server_name = server.name
                resource_group = server.id.split("/")[4]

                # Get databases in this server
                databases = sql_client.databases.list_by_server(
                    resource_group, server_name
                )

                for db in databases:
                    if db.name == "master":  # Skip system database
                        continue

                    metadata = {
                        "server_name": server_name,
                        "database_name": db.name,
                        "sku": db.sku.name if db.sku else "Unknown",
                        "max_size_bytes": db.max_size_bytes,
                        "status": db.status,
                        "location": db.location,
                        "resource_group": resource_group,
                    }

                    resources.append(
                        self.format_resource(
                            resource_id=db.id,
                            resource_name=f"{server_name}/{db.name}",
                            resource_type="Azure SQL Database",
                            region=db.location,
                            status=db.status,
                            ip_address=server.fully_qualified_domain_name,
                            metadata=metadata,
                        )
                    )

            self.log_discovery("Azure SQL Databases", len(resources))
        except AzureError as e:
            logger.error(f"Error discovering Azure SQL Databases: {e}")

        return resources

    def discover_compute(self) -> List[Dict[str, Any]]:
        """Discover all compute resources"""
        return self.discover_virtual_machines()

    def discover_storage(self) -> List[Dict[str, Any]]:
        """Discover all storage resources"""
        return self.discover_storage_accounts()

    def discover_databases(self) -> List[Dict[str, Any]]:
        """Discover all database resources"""
        return self.discover_sql_databases()

    def discover_networking(self) -> List[Dict[str, Any]]:
        """Discover all networking resources"""
        # Can add VNets, NSGs, Load Balancers, etc.
        return []

    def discover_all(self) -> Dict[str, List[Dict[str, Any]]]:
        """Run comprehensive discovery across all Azure services"""
        if not self.authenticate():
            return {"error": "Authentication failed"}

        logger.info(f"🚀 Starting comprehensive Azure discovery for {self.account_name}")

        all_resources = {
            "compute": self.discover_compute(),
            "storage": self.discover_storage(),
            "databases": self.discover_databases(),
            "networking": self.discover_networking(),
        }

        flat_resources = []
        for category, resources in all_resources.items():
            flat_resources.extend(resources)

        all_resources["all"] = flat_resources
        all_resources["summary"] = {
            "total_resources": len(flat_resources),
            "compute_count": len(all_resources["compute"]),
            "storage_count": len(all_resources["storage"]),
            "database_count": len(all_resources["databases"]),
            "networking_count": len(all_resources["networking"]),
            "provider": self.provider,
            "account_name": self.account_name,
            "region": self.region,
        }

        logger.info(
            f"✅ Azure Discovery complete: {len(flat_resources)} total resources found"
        )

        return all_resources
