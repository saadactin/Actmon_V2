"""OCI resource scanner — full coverage: Compute, Block Volumes, Object Storage, DBs,
VCN, NSG, Load Balancers, Functions, OKE (Kubernetes), API Gateway, IAM Groups,
across ALL subscribed OCI regions."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

import oci

from app.providers.oci.oci_auth import OCIAuth

logger = logging.getLogger("cloud_svc.oci.scanner")

_TIMEOUT = oci.retry.DEFAULT_RETRY_STRATEGY


class OCIScanner:
    def __init__(self, auth: OCIAuth) -> None:
        self.auth = auth
        self.config = auth.get_config()

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _client_for_region(self, client_class, region: str):
        """Create an OCI client configured for a specific region."""
        cfg = dict(self.config)
        cfg["region"] = region
        return client_class(cfg)

    # ── Region Discovery ──────────────────────────────────────────────────────

    async def _get_subscribed_regions(self) -> List[str]:
        """Return all region names the tenancy is subscribed to."""
        loop = asyncio.get_event_loop()

        def _fetch():
            identity = oci.identity.IdentityClient(self.config)
            subscriptions = identity.list_region_subscriptions(
                self.auth.tenancy_ocid
            ).data
            return [s.region_name for s in subscriptions if s.status == "READY"]

        try:
            regions = await loop.run_in_executor(None, _fetch)
            logger.info("OCI subscribed regions: %s", regions)
            return regions or [self.auth.region]
        except Exception as exc:
            logger.warning("OCI region discovery failed, using home region: %s", exc)
            return [self.auth.region]

    # ── Compartment Discovery ─────────────────────────────────────────────────

    async def _get_compartments(self) -> List[str]:
        """Return tenancy root + all active sub-compartments."""
        loop = asyncio.get_event_loop()

        def _fetch():
            identity = oci.identity.IdentityClient(self.config)
            compartments = oci.pagination.list_call_get_all_results(
                identity.list_compartments,
                self.auth.tenancy_ocid,
                compartment_id_in_subtree=True,
            ).data
            ids = [self.auth.tenancy_ocid] + [
                c.id for c in compartments if c.lifecycle_state == "ACTIVE"
            ]
            return ids

        return await loop.run_in_executor(None, _fetch)

    # ── Compute Instances ─────────────────────────────────────────────────────

    async def _scan_compute(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            compute = self._client_for_region(oci.core.ComputeClient, region)
            try:
                instances = oci.pagination.list_call_get_all_results(
                    compute.list_instances, compartment_id
                ).data
            except Exception:
                return []
            results = []
            for inst in instances:
                if inst.lifecycle_state in ("TERMINATED",):
                    continue
                results.append(
                    {
                        "provider_resource_id": inst.id,
                        "resource_type": "ComputeInstance",
                        "resource_name": inst.display_name,
                        "region_or_zone": inst.availability_domain,
                        "status": inst.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "shape": inst.shape,
                            "ocpus": inst.shape_config.ocpus if inst.shape_config else None,
                            "memory_gb": inst.shape_config.memory_in_gbs if inst.shape_config else None,
                            "image_id": inst.image_id,
                            "fault_domain": inst.fault_domain,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(inst.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": {**inst.defined_tags.get("Oracle-Tags", {}), **inst.freeform_tags},
                        "raw_data": {
                            "id": inst.id,
                            "display_name": inst.display_name,
                            "lifecycle_state": inst.lifecycle_state,
                        },
                    }
                )
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── Block Volumes ─────────────────────────────────────────────────────────

    async def _scan_block_volumes(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            block = self._client_for_region(oci.core.BlockstorageClient, region)
            try:
                volumes = oci.pagination.list_call_get_all_results(
                    block.list_volumes, compartment_id
                ).data
            except Exception:
                return []
            results = []
            for vol in volumes:
                if vol.lifecycle_state in ("TERMINATED",):
                    continue
                results.append(
                    {
                        "provider_resource_id": vol.id,
                        "resource_type": "BlockVolume",
                        "resource_name": vol.display_name,
                        "region_or_zone": vol.availability_domain,
                        "status": vol.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "size_gb": vol.size_in_gbs,
                            "vpus_per_gb": vol.vpus_per_gb,
                            "is_auto_tune_enabled": vol.is_auto_tune_enabled,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(vol.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": vol.freeform_tags,
                        "raw_data": {"id": vol.id, "display_name": vol.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── Object Storage Buckets ────────────────────────────────────────────────

    async def _scan_object_storage(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ns_client = self._client_for_region(oci.object_storage.ObjectStorageClient, region)
            try:
                namespace = ns_client.get_namespace(compartment_id=compartment_id).data
                buckets = oci.pagination.list_call_get_all_results(
                    ns_client.list_buckets, namespace, compartment_id
                ).data
            except Exception:
                return []
            results = []
            for b in buckets:
                results.append(
                    {
                        "provider_resource_id": f"{namespace}/{b.name}",
                        "resource_type": "ObjectStorageBucket",
                        "resource_name": b.name,
                        "region_or_zone": region,
                        "status": "active",
                        "ip_address": None,
                        "config": {"namespace": namespace, "storage_tier": b.storage_tier},
                        "metadata": {"time_created": str(b.time_created), "region": region},
                        "cost_monthly": None,
                        "tags": b.freeform_tags or {},
                        "raw_data": {"name": b.name, "namespace": namespace},
                    }
                )
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── Autonomous Databases ──────────────────────────────────────────────────

    async def _scan_databases(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            db = self._client_for_region(oci.database.DatabaseClient, region)
            results = []
            try:
                adbs = oci.pagination.list_call_get_all_results(
                    db.list_autonomous_databases, compartment_id
                ).data
                for adb in adbs:
                    if adb.lifecycle_state in ("TERMINATED",):
                        continue
                    results.append(
                        {
                            "provider_resource_id": adb.id,
                            "resource_type": "AutonomousDatabase",
                            "resource_name": adb.display_name,
                            "region_or_zone": region,
                            "status": adb.lifecycle_state,
                            "ip_address": None,
                            "config": {
                                "db_name": adb.db_name,
                                "cpu_core_count": adb.cpu_core_count,
                                "data_storage_size_tbs": adb.data_storage_size_in_tbs,
                                "db_workload": adb.db_workload,
                                "is_auto_scaling_enabled": adb.is_auto_scaling_enabled,
                            },
                            "metadata": {
                                "time_created": str(adb.time_created),
                                "region": region,
                            },
                            "cost_monthly": None,
                            "tags": adb.freeform_tags or {},
                            "raw_data": {"id": adb.id, "display_name": adb.display_name},
                        }
                    )
            except Exception as exc:
                logger.warning("OCI ADB scan failed [%s/%s]: %s", region, compartment_id[:20], exc)
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── VCN (Virtual Cloud Network) ───────────────────────────────────────────

    async def _scan_vcn(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                vcns = oci.pagination.list_call_get_all_results(
                    net.list_vcns, compartment_id
                ).data
            except Exception:
                return []
            results = []
            for vcn in vcns:
                if vcn.lifecycle_state in ("TERMINATED",):
                    continue
                results.append(
                    {
                        "provider_resource_id": vcn.id,
                        "resource_type": "VCN",
                        "resource_name": vcn.display_name,
                        "region_or_zone": region,
                        "status": vcn.lifecycle_state,
                        "ip_address": vcn.cidr_block,
                        "config": {
                            "cidr_block": vcn.cidr_block,
                            "cidr_blocks": vcn.cidr_blocks or [],
                            "dns_label": vcn.dns_label,
                            "domain_name": vcn.vcn_domain_name,
                            "is_ipv6_enabled": getattr(vcn, "is_ipv6_enabled", False),
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(vcn.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": vcn.freeform_tags or {},
                        "raw_data": {"id": vcn.id, "display_name": vcn.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── Network Security Groups (NSG) ─────────────────────────────────────────

    async def _scan_nsg(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                nsgs = oci.pagination.list_call_get_all_results(
                    net.list_network_security_groups, compartment_id
                ).data
            except Exception:
                return []
            results = []
            for nsg in nsgs:
                if nsg.lifecycle_state in ("TERMINATED",):
                    continue
                # Fetch rules count
                try:
                    rules = net.list_network_security_group_security_rules(nsg.id).data
                    rule_count = len(rules)
                    ingress_count = sum(1 for r in rules if r.direction == "INGRESS")
                    egress_count = sum(1 for r in rules if r.direction == "EGRESS")
                except Exception:
                    rule_count = 0
                    ingress_count = 0
                    egress_count = 0

                results.append(
                    {
                        "provider_resource_id": nsg.id,
                        "resource_type": "NetworkSecurityGroup",
                        "resource_name": nsg.display_name,
                        "region_or_zone": region,
                        "status": nsg.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "vcn_id": nsg.vcn_id,
                            "total_rules": rule_count,
                            "ingress_rules": ingress_count,
                            "egress_rules": egress_count,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(nsg.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": nsg.freeform_tags or {},
                        "raw_data": {"id": nsg.id, "display_name": nsg.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── Load Balancers ────────────────────────────────────────────────────────

    async def _scan_load_balancers(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            results = []

            # 1. Classic Load Balancers
            try:
                lb_client = self._client_for_region(oci.load_balancer.LoadBalancerClient, region)
                lbs = oci.pagination.list_call_get_all_results(
                    lb_client.list_load_balancers, compartment_id
                ).data
                for lb in lbs:
                    if lb.lifecycle_state in ("DELETED",):
                        continue
                    # Collect IP addresses
                    ips = [
                        ip.ip_address
                        for ip in (lb.ip_addresses or [])
                        if ip.ip_address
                    ]
                    results.append(
                        {
                            "provider_resource_id": lb.id,
                            "resource_type": "LoadBalancer",
                            "resource_name": lb.display_name,
                            "region_or_zone": region,
                            "status": lb.lifecycle_state,
                            "ip_address": ips[0] if ips else None,
                            "config": {
                                "shape_name": lb.shape_name,
                                "is_private": lb.is_private,
                                "ip_addresses": ips,
                                "subnet_ids": lb.subnet_ids or [],
                                "backend_sets": list((lb.backend_sets or {}).keys()),
                                "listeners": list((lb.listeners or {}).keys()),
                                "lb_type": "LoadBalancer",
                            },
                            "metadata": {
                                "compartment_id": compartment_id,
                                "time_created": str(lb.time_created),
                                "region": region,
                            },
                            "cost_monthly": None,
                            "tags": lb.freeform_tags or {},
                            "raw_data": {"id": lb.id, "display_name": lb.display_name},
                        }
                    )
            except Exception as exc:
                logger.debug("OCI LoadBalancer scan [%s/%s]: %s", region, compartment_id[:20], exc)

            # 2. Network Load Balancers
            try:
                nlb_client = self._client_for_region(
                    oci.network_load_balancer.NetworkLoadBalancerClient, region
                )
                nlbs = oci.pagination.list_call_get_all_results(
                    nlb_client.list_network_load_balancers, compartment_id
                ).data
                for nlb in nlbs:
                    if nlb.lifecycle_state in ("DELETED",):
                        continue
                    ips = [
                        ip.ip_address
                        for ip in (nlb.ip_addresses or [])
                        if ip.ip_address
                    ]
                    results.append(
                        {
                            "provider_resource_id": nlb.id,
                            "resource_type": "NetworkLoadBalancer",
                            "resource_name": nlb.display_name,
                            "region_or_zone": region,
                            "status": nlb.lifecycle_state,
                            "ip_address": ips[0] if ips else None,
                            "config": {
                                "is_private": nlb.is_private,
                                "ip_addresses": ips,
                                "subnet_id": nlb.subnet_id,
                                "lb_type": "NetworkLoadBalancer",
                            },
                            "metadata": {
                                "compartment_id": compartment_id,
                                "time_created": str(nlb.time_created),
                                "region": region,
                            },
                            "cost_monthly": None,
                            "tags": nlb.freeform_tags or {},
                            "raw_data": {"id": nlb.id, "display_name": nlb.display_name},
                        }
                    )
            except Exception as exc:
                logger.debug("OCI NLB scan [%s/%s]: %s", region, compartment_id[:20], exc)

            return results

        return await loop.run_in_executor(None, _fetch)

    # ── OCI Functions ─────────────────────────────────────────────────────────

    async def _scan_functions(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            fn_client = self._client_for_region(
                oci.functions.FunctionsManagementClient, region
            )
            results = []
            try:
                # List applications first, then functions within each
                apps = oci.pagination.list_call_get_all_results(
                    fn_client.list_applications, compartment_id
                ).data
                for app in apps:
                    if app.lifecycle_state in ("DELETED",):
                        continue
                    try:
                        functions = oci.pagination.list_call_get_all_results(
                            fn_client.list_functions, app.id
                        ).data
                        for fn in functions:
                            if fn.lifecycle_state in ("DELETED",):
                                continue
                            results.append(
                                {
                                    "provider_resource_id": fn.id,
                                    "resource_type": "Function",
                                    "resource_name": fn.display_name,
                                    "region_or_zone": region,
                                    "status": fn.lifecycle_state,
                                    "ip_address": fn.invoke_endpoint,
                                    "config": {
                                        "application_id": app.id,
                                        "application_name": app.display_name,
                                        "image": fn.image,
                                        "image_digest": fn.image_digest,
                                        "memory_in_mbs": fn.memory_in_mbs,
                                        "timeout_in_seconds": fn.timeout_in_seconds,
                                        "invoke_endpoint": fn.invoke_endpoint,
                                    },
                                    "metadata": {
                                        "compartment_id": compartment_id,
                                        "time_created": str(fn.time_created),
                                        "region": region,
                                    },
                                    "cost_monthly": None,
                                    "tags": fn.freeform_tags or {},
                                    "raw_data": {
                                        "id": fn.id,
                                        "display_name": fn.display_name,
                                        "application_id": app.id,
                                    },
                                }
                            )
                    except Exception as exc:
                        logger.debug("OCI Functions list [app=%s]: %s", app.id[:20], exc)
            except Exception as exc:
                logger.debug("OCI Functions Applications scan [%s/%s]: %s", region, compartment_id[:20], exc)
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── OKE (Container Engine for Kubernetes) ─────────────────────────────────

    async def _scan_oke(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            oke_client = self._client_for_region(
                oci.container_engine.ContainerEngineClient, region
            )
            try:
                clusters = oci.pagination.list_call_get_all_results(
                    oke_client.list_clusters, compartment_id
                ).data
            except Exception:
                return []
            results = []
            for cluster in clusters:
                if cluster.lifecycle_state in ("DELETED",):
                    continue
                # Fetch node pool count
                try:
                    node_pools = oke_client.list_node_pools(
                        compartment_id, cluster_id=cluster.id
                    ).data
                    node_pool_count = len(node_pools)
                except Exception:
                    node_pool_count = 0

                endpoint = None
                if cluster.endpoints:
                    endpoint = cluster.endpoints.public_endpoint or cluster.endpoints.private_endpoint

                results.append(
                    {
                        "provider_resource_id": cluster.id,
                        "resource_type": "OKECluster",
                        "resource_name": cluster.name,
                        "region_or_zone": region,
                        "status": cluster.lifecycle_state,
                        "ip_address": endpoint,
                        "config": {
                            "kubernetes_version": cluster.kubernetes_version,
                            "vcn_id": cluster.vcn_id,
                            "node_pool_count": node_pool_count,
                            "endpoint": endpoint,
                            "endpoint_config": {
                                "is_public_ip_enabled": getattr(
                                    cluster.endpoint_config, "is_public_ip_enabled", None
                                ) if cluster.endpoint_config else None,
                            },
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(cluster.metadata.time_created) if cluster.metadata else None,
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": cluster.freeform_tags or {},
                        "raw_data": {"id": cluster.id, "name": cluster.name},
                    }
                )
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── API Gateway ───────────────────────────────────────────────────────────

    async def _scan_api_gateway(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            gw_client = self._client_for_region(oci.apigateway.GatewayClient, region)
            deploy_client = self._client_for_region(oci.apigateway.DeploymentClient, region)
            results = []

            try:
                gateways = oci.pagination.list_call_get_all_results(
                    gw_client.list_gateways, compartment_id
                ).data
                for gw in gateways:
                    if gw.lifecycle_state in ("DELETED",):
                        continue

                    # Fetch deployments for this gateway
                    try:
                        deployments = oci.pagination.list_call_get_all_results(
                            deploy_client.list_deployments,
                            compartment_id,
                            gateway_id=gw.id,
                        ).data
                        deployment_names = [d.display_name for d in deployments if d.lifecycle_state != "DELETED"]
                    except Exception:
                        deployment_names = []

                    results.append(
                        {
                            "provider_resource_id": gw.id,
                            "resource_type": "APIGateway",
                            "resource_name": gw.display_name,
                            "region_or_zone": region,
                            "status": gw.lifecycle_state,
                            "ip_address": gw.hostname,
                            "config": {
                                "endpoint_type": gw.endpoint_type,
                                "hostname": gw.hostname,
                                "subnet_id": gw.subnet_id,
                                "certificate_id": gw.certificate_id,
                                "deployments": deployment_names,
                                "deployment_count": len(deployment_names),
                            },
                            "metadata": {
                                "compartment_id": compartment_id,
                                "time_created": str(gw.time_created),
                                "region": region,
                            },
                            "cost_monthly": None,
                            "tags": gw.freeform_tags or {},
                            "raw_data": {"id": gw.id, "display_name": gw.display_name},
                        }
                    )
            except Exception as exc:
                logger.debug("OCI API Gateway scan [%s/%s]: %s", region, compartment_id[:20], exc)
            return results

        return await loop.run_in_executor(None, _fetch)

    # ── IAM Groups & Policies (global, no region loop) ────────────────────────

    async def _scan_iam_groups(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            identity = oci.identity.IdentityClient(self.config)
            results = []

            # Groups
            try:
                groups = oci.pagination.list_call_get_all_results(
                    identity.list_groups, self.auth.tenancy_ocid
                ).data
                for grp in groups:
                    if grp.lifecycle_state in ("DELETED",):
                        continue
                    # Count members
                    try:
                        memberships = identity.list_user_group_memberships(
                            self.auth.tenancy_ocid, group_id=grp.id
                        ).data
                        member_count = len(memberships)
                    except Exception:
                        member_count = 0

                    results.append(
                        {
                            "provider_resource_id": grp.id,
                            "resource_type": "IAMGroup",
                            "resource_name": grp.name,
                            "region_or_zone": "global",
                            "status": grp.lifecycle_state,
                            "ip_address": None,
                            "config": {
                                "description": grp.description,
                                "member_count": member_count,
                            },
                            "metadata": {
                                "time_created": str(grp.time_created),
                                "compartment_id": self.auth.tenancy_ocid,
                            },
                            "cost_monthly": None,
                            "tags": grp.freeform_tags or {},
                            "raw_data": {"id": grp.id, "name": grp.name},
                        }
                    )
            except Exception as exc:
                logger.warning("OCI IAM Groups scan failed: %s", exc)

            # Policies
            try:
                policies = oci.pagination.list_call_get_all_results(
                    identity.list_policies, self.auth.tenancy_ocid
                ).data
                for pol in policies:
                    if pol.lifecycle_state in ("DELETED",):
                        continue
                    results.append(
                        {
                            "provider_resource_id": pol.id,
                            "resource_type": "IAMPolicy",
                            "resource_name": pol.name,
                            "region_or_zone": "global",
                            "status": pol.lifecycle_state,
                            "ip_address": None,
                            "config": {
                                "description": pol.description,
                                "statement_count": len(pol.statements or []),
                                "statements": pol.statements or [],
                            },
                            "metadata": {
                                "time_created": str(pol.time_created),
                                "compartment_id": pol.compartment_id,
                            },
                            "cost_monthly": None,
                            "tags": pol.freeform_tags or {},
                            "raw_data": {"id": pol.id, "name": pol.name},
                        }
                    )
            except Exception as exc:
                logger.warning("OCI IAM Policies scan failed: %s", exc)

            return results

        return await loop.run_in_executor(None, _fetch)

    # ── Main scan_all ─────────────────────────────────────────────────────────

    async def scan_all(self) -> List[Dict[str, Any]]:
        """Scan ALL resource types across ALL subscribed OCI regions in parallel."""
        # Discover regions and compartments concurrently
        regions, compartments = await asyncio.gather(
            self._get_subscribed_regions(),
            self._get_compartments(),
        )
        logger.info(
            "OCI scanning %d regions × %d compartments",
            len(regions),
            len(compartments),
        )
        all_resources: List[Dict[str, Any]] = []
        permission_errors = []

        # IAM is global (single region call)
        try:
            iam_resources = await self._scan_iam_groups()
            all_resources.extend(iam_resources)
            logger.info("OCI IAM: found %d resources", len(iam_resources))
        except Exception as exc:
            logger.warning("OCI IAM scan failed: %s", exc)
            if "NotAuthorizedOrNotFound" in str(exc) or "Authorization failed" in str(exc):
                permission_errors.append(str(exc))

        # Per-region per-compartment scanners
        PER_REGION_SCANNERS = [
            (self._scan_compute,        "Compute"),
            (self._scan_block_volumes,  "BlockVolume"),
            (self._scan_object_storage, "ObjectStorage"),
            (self._scan_databases,      "Database"),
            (self._scan_vcn,            "VCN"),
            (self._scan_nsg,            "NSG"),
            (self._scan_load_balancers, "LoadBalancer"),
            (self._scan_functions,      "Functions"),
            (self._scan_oke,            "OKE"),
            (self._scan_api_gateway,    "APIGateway"),
        ]

        async def _run(scanner_fn, compartment_id: str, region: str, label: str):
            try:
                results = await scanner_fn(compartment_id, region)
                if results:
                    logger.info(
                        "OCI %s [%s/%s]: %d resources",
                        label, region, compartment_id[:20], len(results),
                    )
                return results
            except Exception as exc:
                logger.warning("OCI %s [%s/%s] failed: %s", label, region, compartment_id[:20], exc)
                if "NotAuthorizedOrNotFound" in str(exc) or "Authorization failed" in str(exc):
                    permission_errors.append(str(exc))
                return []

        tasks = [
            _run(scanner_fn, cid, region, label)
            for region in regions
            for cid in compartments
            for scanner_fn, label in PER_REGION_SCANNERS
        ]

        if tasks:
            results_list = await asyncio.gather(*tasks)
            for results in results_list:
                all_resources.extend(results)

        logger.info("OCI total resources discovered: %d", len(all_resources))

        if len(all_resources) == 0 and len(permission_errors) > 0:
            raise PermissionError("Missing required IAM permissions (Read-Only). Oracle Cloud returned NotAuthorizedOrNotFound during the scan.")

        return all_resources
