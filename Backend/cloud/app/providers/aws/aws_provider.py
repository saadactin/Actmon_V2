"""AWS Cloud Provider — implements BaseCloudProvider."""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.providers.base import BaseCloudProvider
from app.providers.aws.aws_auth import AWSAuth
from app.providers.aws.aws_scanner import AWSScanner
from app.providers.scan_pool import query_pool

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
        return await loop.run_in_executor(query_pool(), _fetch)

    async def get_cost_data(self) -> List[Dict[str, Any]]:
        """Retrieve last 30-day cost breakdown from AWS Cost Explorer."""
        import asyncio
        from datetime import date, timedelta

        def _fetch():
            ce = self.auth.get_client("ce", region="us-east-1", slow_api=True)
            today = date.today()
            start = (today - timedelta(days=30)).isoformat()
            end = today.isoformat()

            # Cost Explorer caps groups per response and returns NextPageToken
            # for the rest; a single call silently under-reports an account with
            # many service/region combinations.
            by_key: Dict[tuple, Dict[str, Any]] = {}
            next_token = None
            while True:
                kwargs: Dict[str, Any] = dict(
                    TimePeriod={"Start": start, "End": end},
                    Granularity="MONTHLY",
                    Metrics=["BlendedCost"],
                    GroupBy=[
                        {"Type": "DIMENSION", "Key": "SERVICE"},
                        {"Type": "DIMENSION", "Key": "REGION"},
                    ],
                )
                if next_token:
                    kwargs["NextPageToken"] = next_token
                response = ce.get_cost_and_usage(**kwargs)
                for result in response.get("ResultsByTime", []):
                    for group in result.get("Groups", []):
                        keys = group.get("Keys", ["", ""])
                        service = keys[0] if len(keys) > 0 else ""
                        region = keys[1] if len(keys) > 1 else ""
                        metric = group.get("Metrics", {}).get("BlendedCost", {})
                        entry = by_key.setdefault((service, region or None), {
                            "resource_type": service,
                            "resource_name": service,
                            "region": region or None,
                            "monthly_cost": 0.0,
                            # Real billing currency from the API; None = unknown
                            "currency": metric.get("Unit"),
                        })
                        entry["monthly_cost"] += float(metric.get("Amount", 0) or 0)
                next_token = response.get("NextPageToken")
                if not next_token:
                    break

            results = list(by_key.values())
            for r in results:
                r["monthly_cost"] = round(r["monthly_cost"], 4)
            return results

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(query_pool(), _fetch)
        except Exception as exc:
            logger.warning("AWS Cost Explorer query failed: %s", exc)
            raise

    async def get_cost_report(self, days: int = 30) -> List[Dict[str, Any]]:
        """Real day-by-day, per-service spend from AWS Cost Explorer, for an
        arbitrary lookback window (up to CE's ~14-month retention)."""
        import asyncio
        from datetime import date, timedelta

        def _fetch():
            ce = self.auth.get_client("ce", region="us-east-1", slow_api=True)
            today = date.today()
            start = (today - timedelta(days=days)).isoformat()
            end = today.isoformat()
            rows: List[Dict[str, Any]] = []
            next_token = None
            while True:
                kwargs: Dict[str, Any] = dict(
                    TimePeriod={"Start": start, "End": end},
                    Granularity="DAILY",
                    Metrics=["BlendedCost"],
                    GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
                )
                if next_token:
                    kwargs["NextPageToken"] = next_token
                response = ce.get_cost_and_usage(**kwargs)
                for result in response.get("ResultsByTime", []):
                    usage_date = result.get("TimePeriod", {}).get("Start")
                    for group in result.get("Groups", []):
                        keys = group.get("Keys", [""])
                        service = keys[0] if keys else "Unknown"
                        metric = group.get("Metrics", {}).get("BlendedCost", {})
                        rows.append({
                            "date": usage_date,
                            "service": service,
                            "region": None,
                            "cost": round(float(metric.get("Amount", 0)), 4),
                            "currency": metric.get("Unit"),
                        })
                next_token = response.get("NextPageToken")
                if not next_token:
                    break
            return rows

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(query_pool(), _fetch)
        except Exception as exc:
            logger.warning("AWS Cost Explorer report query failed: %s", exc)
            raise

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
            return await loop.run_in_executor(query_pool(), _fetch)
        except Exception as exc:
            logger.warning("AWS daily cost query failed: %s", exc)
            raise
