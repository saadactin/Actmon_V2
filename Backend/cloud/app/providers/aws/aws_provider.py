"""AWS Cloud Provider — implements BaseCloudProvider."""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.providers.base import BaseCloudProvider
from app.providers.aws.aws_auth import AWSAuth
from app.providers.aws.aws_scanner import AWSScanner

logger = logging.getLogger("cloud_svc.aws")


class AWSProvider(BaseCloudProvider):
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.auth = AWSAuth(credentials)
        self.scanner = AWSScanner(self.auth)

    async def authenticate(self) -> bool:
        return await self.auth.validate()

    async def scan_resources(self, on_batch=None) -> List[Dict[str, Any]]:
        return await self.scanner.scan_all(on_batch=on_batch)

    async def get_resource_details(self, resource_id: str) -> Dict[str, Any]:
        """Describe a single EC2 instance by instance-id (extend for other types)."""
        import asyncio

        def _fetch():
            ec2 = self.auth.get_client("ec2")
            resp = ec2.describe_instances(InstanceIds=[resource_id])
            reservations = resp.get("Reservations", [])
            if reservations:
                return reservations[0]["Instances"][0]
            return {}

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _fetch)

    async def get_cost_data(self) -> List[Dict[str, Any]]:
        """Retrieve last 30-day cost breakdown from AWS Cost Explorer."""
        import asyncio
        from datetime import date, timedelta

        def _fetch():
            ce = self.auth.get_client("ce", region="us-east-1", slow_api=True)
            today = date.today()
            start = (today - timedelta(days=30)).isoformat()
            end = today.isoformat()
            response = ce.get_cost_and_usage(
                TimePeriod={"Start": start, "End": end},
                Granularity="MONTHLY",
                Metrics=["BlendedCost"],
                GroupBy=[
                    {"Type": "DIMENSION", "Key": "SERVICE"},
                    {"Type": "DIMENSION", "Key": "REGION"},
                ],
            )
            results = []
            for result in response.get("ResultsByTime", []):
                for group in result.get("Groups", []):
                    keys = group.get("Keys", ["", ""])
                    service = keys[0] if len(keys) > 0 else ""
                    region = keys[1] if len(keys) > 1 else ""
                    metric = group.get("Metrics", {}).get("BlendedCost", {})
                    cost = float(metric.get("Amount", 0))
                    results.append(
                        {
                            "resource_type": service,
                            "resource_name": service,
                            "region": region or None,
                            "monthly_cost": round(cost, 4),
                            # Real billing currency from the API (e.g. USD/INR); None = unknown
                            "currency": metric.get("Unit"),
                        }
                    )
            return results

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _fetch)
        except Exception as exc:
            logger.warning("AWS Cost Explorer query failed: %s", exc)
            return []

    async def get_daily_costs(self) -> List[Dict[str, Any]]:
        """Real per-day spend for the last 30 days from Cost Explorer."""
        import asyncio
        from datetime import date, timedelta

        def _fetch():
            ce = self.auth.get_client("ce", region="us-east-1", slow_api=True)
            today = date.today()
            response = ce.get_cost_and_usage(
                TimePeriod={
                    "Start": (today - timedelta(days=30)).isoformat(),
                    "End": today.isoformat(),
                },
                Granularity="DAILY",
                Metrics=["BlendedCost"],
            )
            results = []
            for bucket in response.get("ResultsByTime", []):
                metric = bucket.get("Total", {}).get("BlendedCost", {})
                results.append(
                    {
                        "date": bucket.get("TimePeriod", {}).get("Start"),
                        "cost": round(float(metric.get("Amount", 0)), 4),
                        "currency": metric.get("Unit"),
                    }
                )
            return results

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _fetch)
        except Exception as exc:
            logger.warning("AWS daily cost query failed: %s", exc)
            return []
