"""
Oracle Cloud (OCI) Comprehensive Discovery Engine
Deep-dive analysis of OCI resources
"""

import oci
from typing import Dict, List, Any
import logging
from cloud.core.base_discovery import BaseCloudDiscovery

logger = logging.getLogger(__name__)


class OracleCloudDiscovery(BaseCloudDiscovery):
    """Comprehensive Oracle Cloud Infrastructure discovery"""

    def __init__(self, account_config: Dict[str, Any]):
        super().__init__(account_config)
        self.user_ocid = account_config.get("oci_user_ocid")
        self.fingerprint = account_config.get("oci_fingerprint")
        self.private_key_content = account_config.get("oci_private_key_content")
        self.tenancy_ocid = account_config.get("tenant_identifier")
        self.passphrase = account_config.get("oci_passphrase")
        self.config = None
        self.clients = {}

    def authenticate(self) -> bool:
        """Authenticate with Oracle Cloud"""
        try:
            self.config = {
                "user": self.user_ocid,
                "key_content": self.private_key_content,
                "fingerprint": self.fingerprint,
                "tenancy": self.tenancy_ocid,
                "region": self.region or "us-ashburn-1",
            }

            if self.passphrase:
                self.config["pass_phrase"] = self.passphrase

            # Test authentication with identity client
            identity_client = oci.identity.IdentityClient(self.config)
            identity_client.get_tenancy(self.tenancy_ocid)

            logger.info(f"✅ Oracle Cloud Authentication successful: {self.tenancy_ocid}")
            return True

        except Exception as e:
            logger.error(f"❌ Oracle Cloud Authentication failed: {e}")
            return False

    def get_compute_client(self):
        """Get OCI Compute Client"""
        if "compute" not in self.clients:
            self.clients["compute"] = oci.core.ComputeClient(self.config)
        return self.clients["compute"]

    def get_block_storage_client(self):
        """Get OCI Block Storage Client"""
        if "block_storage" not in self.clients:
            self.clients["block_storage"] = oci.core.BlockstorageClient(self.config)
        return self.clients["block_storage"]

    def get_object_storage_client(self):
        """Get OCI Object Storage Client"""
        if "object_storage" not in self.clients:
            self.clients["object_storage"] = oci.object_storage.ObjectStorageClient(
                self.config
            )
        return self.clients["object_storage"]

    def get_database_client(self):
        """Get OCI Database Client"""
        if "database" not in self.clients:
            self.clients["database"] = oci.database.DatabaseClient(self.config)
        return self.clients["database"]

    def discover_compute_instances(self) -> List[Dict[str, Any]]:
        """Discover OCI Compute Instances"""
        resources = []
        try:
            compute_client = self.get_compute_client()
            identity_client = oci.identity.IdentityClient(self.config)

            # Get all compartments
            compartments = identity_client.list_compartments(
                self.tenancy_ocid
            ).data

            for compartment in compartments:
                try:
                    instances = compute_client.list_instances(
                        compartment.id
                    ).data

                    for instance in instances:
                        instance_name = instance.display_name

                        # Get VNIC attachments to find IP
                        vnics = compute_client.list_vnic_attachments(
                            compartment.id, instance_id=instance.id
                        ).data

                        private_ip = None
                        if vnics:
                            vnic_id = vnics[0].vnic_id
                            network_client = oci.core.VirtualNetworkClient(self.config)
                            vnic = network_client.get_vnic(vnic_id).data
                            private_ip = vnic.private_ip

                        metadata = {
                            "shape": instance.shape,
                            "lifecycle_state": instance.lifecycle_state,
                            "availability_domain": instance.availability_domain,
                            "compartment_id": compartment.id,
                            "compartment_name": compartment.name,
                            "time_created": str(instance.time_created),
                            "private_ip": private_ip,
                        }

                        resources.append(
                            self.format_resource(
                                resource_id=instance.id,
                                resource_name=instance_name,
                                resource_type="OCI Compute Instance",
                                region=instance.availability_domain,
                                status=instance.lifecycle_state,
                                ip_address=private_ip,
                                metadata=metadata,
                            )
                        )
                except Exception as e:
                    logger.warning(f"Error discovering instances in compartment: {e}")

            self.log_discovery("OCI Compute Instances", len(resources))
        except Exception as e:
            logger.error(f"Error discovering OCI Compute Instances: {e}")

        return resources

    def discover_object_storage_buckets(self) -> List[Dict[str, Any]]:
        """Discover OCI Object Storage Buckets"""
        resources = []
        try:
            object_storage_client = self.get_object_storage_client()
            identity_client = oci.identity.IdentityClient(self.config)

            # Get namespace
            namespace = object_storage_client.get_namespace().data

            # Get all compartments
            compartments = identity_client.list_compartments(
                self.tenancy_ocid
            ).data

            for compartment in compartments:
                try:
                    buckets = object_storage_client.list_buckets(
                        namespace, compartment.id
                    ).data

                    for bucket in buckets:
                        bucket_name = bucket.name

                        metadata = {
                            "namespace": namespace,
                            "compartment_name": compartment.name,
                            "time_created": str(bucket.time_created),
                            "public_access_type": bucket.public_access_type,
                        }

                        resources.append(
                            self.format_resource(
                                resource_id=bucket.name,
                                resource_name=bucket_name,
                                resource_type="OCI Object Storage Bucket",
                                region=self.region,
                                status="Active",
                                ip_address=None,
                                metadata=metadata,
                            )
                        )
                except Exception as e:
                    logger.warning(f"Error discovering buckets in compartment: {e}")

            self.log_discovery("OCI Object Storage Buckets", len(resources))
        except Exception as e:
            logger.error(f"Error discovering OCI Object Storage Buckets: {e}")

        return resources

    def discover_database_systems(self) -> List[Dict[str, Any]]:
        """Discover OCI Database Systems"""
        resources = []
        try:
            database_client = self.get_database_client()
            identity_client = oci.identity.IdentityClient(self.config)

            # Get all compartments
            compartments = identity_client.list_compartments(
                self.tenancy_ocid
            ).data

            for compartment in compartments:
                try:
                    db_systems = database_client.list_db_systems(
                        compartment.id
                    ).data

                    for db_system in db_systems:
                        db_name = db_system.display_name

                        metadata = {
                            "shape": db_system.shape,
                            "lifecycle_state": db_system.lifecycle_state,
                            "availability_domain": db_system.availability_domain,
                            "database_edition": db_system.database_edition,
                            "version": db_system.version,
                            "compartment_name": compartment.name,
                        }

                        resources.append(
                            self.format_resource(
                                resource_id=db_system.id,
                                resource_name=db_name,
                                resource_type="OCI Database System",
                                region=db_system.availability_domain,
                                status=db_system.lifecycle_state,
                                ip_address=None,
                                metadata=metadata,
                            )
                        )
                except Exception as e:
                    logger.warning(f"Error discovering DB systems in compartment: {e}")

            self.log_discovery("OCI Database Systems", len(resources))
        except Exception as e:
            logger.error(f"Error discovering OCI Database Systems: {e}")

        return resources

    def discover_compute(self) -> List[Dict[str, Any]]:
        """Discover all compute resources"""
        return self.discover_compute_instances()

    def discover_storage(self) -> List[Dict[str, Any]]:
        """Discover all storage resources"""
        return self.discover_object_storage_buckets()

    def discover_databases(self) -> List[Dict[str, Any]]:
        """Discover all database resources"""
        return self.discover_database_systems()

    def discover_networking(self) -> List[Dict[str, Any]]:
        """Discover all networking resources"""
        return []

    def discover_all(self) -> Dict[str, List[Dict[str, Any]]]:
        """Run comprehensive discovery across all OCI services"""
        if not self.authenticate():
            return {"error": "Authentication failed"}

        logger.info(
            f"🚀 Starting comprehensive Oracle Cloud discovery for {self.account_name}"
        )

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
            f"✅ Oracle Cloud Discovery complete: {len(flat_resources)} total resources found"
        )

        return all_resources
