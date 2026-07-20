"""OCI Cloud Provider — implements BaseCloudProvider.
Full coverage: Compute, Storage, Databases, VCN, NSG, Load Balancers,
Functions, OKE, API Gateway, IAM, across all subscribed regions."""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.providers.base import BaseCloudProvider
from app.providers.oci.oci_auth import OCIAuth
from app.providers.oci.oci_scanner import OCIScanner

logger = logging.getLogger("cloud_svc.oci")


class OCIProvider(BaseCloudProvider):
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.auth = OCIAuth(credentials)
        self.scanner = OCIScanner(self.auth)

    async def authenticate(self) -> bool:
        return await self.auth.validate()

    async def scan_resources(self, on_batch=None) -> List[Dict[str, Any]]:
        return await self.scanner.scan_all(on_batch=on_batch)

    async def get_resource_details(self, resource_id: str) -> Dict[str, Any]:
        """Attempt to resolve a resource OCID across Compute, DB, Network, Functions, OKE, LB."""
        import asyncio
        import oci

        def _fetch():
            config = self.auth.get_config()

            # Try Compute Instance
            try:
                compute = oci.core.ComputeClient(config)
                instance = compute.get_instance(resource_id).data
                return {
                    "id": instance.id,
                    "display_name": instance.display_name,
                    "resource_type": "ComputeInstance",
                    "lifecycle_state": instance.lifecycle_state,
                    "shape": instance.shape,
                    "availability_domain": instance.availability_domain,
                    "time_created": str(instance.time_created),
                }
            except Exception:
                pass

            # Try Autonomous Database
            try:
                db = oci.database.DatabaseClient(config)
                adb = db.get_autonomous_database(resource_id).data
                return {
                    "id": adb.id,
                    "display_name": adb.display_name,
                    "resource_type": "AutonomousDatabase",
                    "lifecycle_state": adb.lifecycle_state,
                    "db_name": adb.db_name,
                    "time_created": str(adb.time_created),
                }
            except Exception:
                pass

            # Try VCN
            try:
                net = oci.core.VirtualNetworkClient(config)
                vcn = net.get_vcn(resource_id).data
                return {
                    "id": vcn.id,
                    "display_name": vcn.display_name,
                    "resource_type": "VCN",
                    "lifecycle_state": vcn.lifecycle_state,
                    "cidr_block": vcn.cidr_block,
                    "time_created": str(vcn.time_created),
                }
            except Exception:
                pass

            # Try NSG
            try:
                net = oci.core.VirtualNetworkClient(config)
                nsg = net.get_network_security_group(resource_id).data
                return {
                    "id": nsg.id,
                    "display_name": nsg.display_name,
                    "resource_type": "NetworkSecurityGroup",
                    "lifecycle_state": nsg.lifecycle_state,
                    "vcn_id": nsg.vcn_id,
                    "time_created": str(nsg.time_created),
                }
            except Exception:
                pass

            # Try Load Balancer
            try:
                lb_client = oci.load_balancer.LoadBalancerClient(config)
                lb = lb_client.get_load_balancer(resource_id).data
                return {
                    "id": lb.id,
                    "display_name": lb.display_name,
                    "resource_type": "LoadBalancer",
                    "lifecycle_state": lb.lifecycle_state,
                    "shape_name": lb.shape_name,
                    "time_created": str(lb.time_created),
                }
            except Exception:
                pass

            # Try OKE Cluster
            try:
                oke = oci.container_engine.ContainerEngineClient(config)
                cluster = oke.get_cluster(resource_id).data
                return {
                    "id": cluster.id,
                    "name": cluster.name,
                    "resource_type": "OKECluster",
                    "lifecycle_state": cluster.lifecycle_state,
                    "kubernetes_version": cluster.kubernetes_version,
                }
            except Exception:
                pass

            # Try Function
            try:
                fn_client = oci.functions.FunctionsManagementClient(config)
                fn = fn_client.get_function(resource_id).data
                return {
                    "id": fn.id,
                    "display_name": fn.display_name,
                    "resource_type": "Function",
                    "lifecycle_state": fn.lifecycle_state,
                    "memory_in_mbs": fn.memory_in_mbs,
                    "invoke_endpoint": fn.invoke_endpoint,
                    "time_created": str(fn.time_created),
                }
            except Exception:
                pass

            # Try API Gateway
            try:
                gw_client = oci.apigateway.GatewayClient(config)
                gw = gw_client.get_gateway(resource_id).data
                return {
                    "id": gw.id,
                    "display_name": gw.display_name,
                    "resource_type": "APIGateway",
                    "lifecycle_state": gw.lifecycle_state,
                    "hostname": gw.hostname,
                    "endpoint_type": gw.endpoint_type,
                    "time_created": str(gw.time_created),
                }
            except Exception:
                pass

            return {"id": resource_id, "error": "Resource not found across known OCI resource types"}

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _fetch)

    async def get_cost_data(self) -> List[Dict[str, Any]]:
        """OCI Usage API — retrieve cost per service for the last 30 days."""
        import asyncio
        from datetime import date, timedelta

        def _fetch():
            import oci

            usage_client = oci.usage_api.UsageapiClient(self.auth.get_config())
            # Usage API requires midnight-aligned UTC timestamps; MONTHLY
            # granularity additionally requires month-aligned starts, so use
            # DAILY over a rolling 30-day window and aggregate per service.
            today = date.today()
            start = (today - timedelta(days=30)).strftime("%Y-%m-%dT00:00:00Z")
            end = today.strftime("%Y-%m-%dT00:00:00Z")
            request = oci.usage_api.models.RequestSummarizedUsagesDetails(
                tenant_id=self.auth.tenancy_ocid,
                time_usage_started=start,
                time_usage_ended=end,
                granularity="DAILY",
                query_type="COST",
                group_by=["service", "region"],
            )
            response = usage_client.request_summarized_usages(
                request_summarized_usages_details=request
            )
            by_key: Dict[tuple, Dict[str, Any]] = {}
            for item in response.data.items or []:
                service = item.service or "Unknown"
                # Real region from the usage row; None = unknown (UI shows NA)
                region = getattr(item, "region", None) or None
                row = by_key.setdefault(
                    (service, region),
                    {
                        "resource_type": service,
                        "resource_name": service,
                        "region": region,
                        "monthly_cost": 0.0,
                        "currency": item.currency or None,
                    },
                )
                row["monthly_cost"] += float(item.computed_amount or 0)
            results = list(by_key.values())
            for row in results:
                row["monthly_cost"] = round(row["monthly_cost"], 2)
            results.sort(key=lambda r: -r["monthly_cost"])
            return results

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _fetch)
        except Exception as exc:
            logger.warning("OCI cost API failed: %s", exc)
            return []

    async def get_daily_costs(self) -> List[Dict[str, Any]]:
        """Real per-day spend for the last 30 days from the OCI Usage API."""
        import asyncio
        from datetime import date, timedelta

        def _fetch():
            import oci

            usage_client = oci.usage_api.UsageapiClient(self.auth.get_config())
            today = date.today()
            start = (today - timedelta(days=30)).strftime("%Y-%m-%dT00:00:00Z")
            end = today.strftime("%Y-%m-%dT00:00:00Z")
            request = oci.usage_api.models.RequestSummarizedUsagesDetails(
                tenant_id=self.auth.tenancy_ocid,
                time_usage_started=start,
                time_usage_ended=end,
                granularity="DAILY",
                query_type="COST",
            )
            response = usage_client.request_summarized_usages(
                request_summarized_usages_details=request
            )
            by_day: Dict[str, Dict[str, Any]] = {}
            for item in response.data.items or []:
                started = getattr(item, "time_usage_started", None)
                if not started:
                    continue
                day = str(started)[:10]
                row = by_day.setdefault(
                    day,
                    {"date": day, "cost": 0.0, "currency": item.currency or None},
                )
                row["cost"] += float(item.computed_amount or 0)
            results = sorted(by_day.values(), key=lambda r: r["date"])
            for row in results:
                row["cost"] = round(row["cost"], 4)
            return results

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _fetch)
        except Exception as exc:
            logger.warning("OCI daily cost query failed: %s", exc)
            return []

    async def get_security_data(self) -> List[Dict[str, Any]]:
        """OCI Cloud Guard — fetch security problems across all compartments."""
        import asyncio

        def _fetch():
            import oci

            try:
                cg_client = oci.cloud_guard.CloudGuardClient(self.auth.get_config())
                problems = oci.pagination.list_call_get_all_results(
                    cg_client.list_problems,
                    self.auth.tenancy_ocid,
                    lifecycle_state="OPEN",
                ).data
                results = []
                for prob in problems:
                    results.append(
                        {
                            "finding_id": prob.id,
                            "title": prob.detector_rule_id,
                            "severity": (prob.risk_level or "UNKNOWN").upper(),
                            "resource_type": prob.resource_type,
                            "resource_id": prob.resource_id,
                            "region": prob.region,
                            "status": prob.lifecycle_state,
                            "detected_at": str(prob.time_first_detected),
                            "description": prob.detector_rule_id,
                            "compartment_id": prob.compartment_id,
                        }
                    )
                return results
            except Exception as exc:
                logger.warning("OCI Cloud Guard scan failed: %s", exc)
                return []

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _fetch)
