"""Azure Cloud Provider — implements BaseCloudProvider."""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.providers.base import BaseCloudProvider
from app.providers.azure.azure_auth import AzureAuth
from app.providers.azure.azure_scanner import AzureScanner

logger = logging.getLogger("cloud_svc.azure")


class AzureProvider(BaseCloudProvider):
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.auth = AzureAuth(credentials)
        self.scanner = AzureScanner(self.auth)

    async def authenticate(self) -> bool:
        return await self.auth.validate()

    async def scan_resources(self) -> List[Dict[str, Any]]:
        return await self.scanner.scan_all()

    async def get_resource_details(self, resource_id: str) -> Dict[str, Any]:
        import asyncio

        def _fetch():
            client = self.auth.get_resource_client()
            # resource_id is a full Azure resource ID path
            parts = resource_id.split("/")
            if len(parts) < 9:
                return {}
            resource_group = parts[4]
            provider_ns = parts[6]
            resource_type = parts[7]
            resource_name = parts[8]
            resource = client.resources.get(
                resource_group_name=resource_group,
                resource_provider_namespace=provider_ns,
                parent_resource_path="",
                resource_type=resource_type,
                resource_name=resource_name,
                api_version="2021-04-01",
            )
            return resource.as_dict()

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _fetch)

    async def get_cost_data(self) -> List[Dict[str, Any]]:
        """Azure Cost Management API — returns cost by service."""
        import asyncio
        from datetime import date, timedelta

        def _fetch():
            from azure.mgmt.costmanagement import CostManagementClient
            from azure.mgmt.costmanagement.models import (
                QueryDefinition, QueryTimePeriod,
                QueryDataset, QueryAggregation, QueryGrouping
            )

            cm = CostManagementClient(self.auth.get_credential())
            today = date.today()
            start = (today - timedelta(days=30)).strftime("%Y-%m-%dT00:00:00Z")
            end = today.strftime("%Y-%m-%dT23:59:59Z")
            scope = f"/subscriptions/{self.auth.subscription_id}"
            query = QueryDefinition(
                type="ActualCost",
                timeframe="Custom",
                time_period=QueryTimePeriod(from_property=start, to=end),
                dataset=QueryDataset(
                    # granularity=None → one total per group over the whole period.
                    # (SDK 4.x GranularityType only defines DAILY; MONTHLY was removed.)
                    granularity=None,
                    aggregation={"totalCost": QueryAggregation(name="Cost", function="Sum")},
                    grouping=[QueryGrouping(type="Dimension", name="ServiceName")],
                ),
            )
            result = cm.query.usage(scope=scope, parameters=query)
            rows = result.rows or []
            cols = [c.name for c in (result.columns or [])]
            costs = []
            for row in rows:
                row_dict = dict(zip(cols, row))
                costs.append(
                    {
                        "resource_type": row_dict.get("ServiceName", "Unknown"),
                        "resource_name": row_dict.get("ServiceName", "Unknown"),
                        "region": "global",
                        "monthly_cost": float(row_dict.get("Cost", 0)),
                        "currency": row_dict.get("Currency", "USD"),
                    }
                )
            return costs

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _fetch)
        except Exception as exc:
            logger.warning("Azure Cost Management query failed: %s", exc)
            return []
