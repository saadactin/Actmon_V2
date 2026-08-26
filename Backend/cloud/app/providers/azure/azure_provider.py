"""Azure Cloud Provider — implements BaseCloudProvider."""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.providers.base import BaseCloudProvider
from app.providers.azure.azure_auth import AzureAuth
from app.providers.azure.azure_scanner import AzureScanner
from app.providers.scan_pool import query_pool

logger = logging.getLogger("cloud_svc.azure")


class AzureProvider(BaseCloudProvider):
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.auth = AzureAuth(credentials)
        self.scanner = AzureScanner(self.auth)

    async def authenticate(self) -> bool:
        return await self.auth.validate()

    async def scan_resources(self, on_batch=None) -> List[Dict[str, Any]]:
        return await self.scanner.scan_all(on_batch=on_batch)

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
        return await loop.run_in_executor(query_pool(), _fetch)

    # ── Cost Management query plumbing ───────────────────────────────────────
    # Two correctness problems the raw SDK call leaves to the caller:
    #
    #  1. Truncation. query.usage() returns at most one page and exposes a
    #     next_link when there is more; ignoring it silently drops cost rows.
    #     A 365-day DAILY × ServiceName × Location query easily exceeds the page
    #     size, so totals came back quietly short. The SDK offers no skiptoken
    #     parameter, so completeness is achieved by halving the time window and
    #     recursing whenever a response reports next_link — the union of the
    #     halves is the whole period, with no page cursor needed.
    #  2. Throttling. Cost Management is aggressively rate-limited (429) and the
    #     SDK does not retry, so a burst of queries fails outright.

    _MAX_SPLIT_DEPTH = 6      # 365d → ~6d windows worst case
    _RETRY_ATTEMPTS = 4
    _MAX_BACKOFF_SECONDS = 60  # cap a Retry-After so a request can't hang

    def _cm_query(self, cm, scope, granularity, groupings, start_dt, end_dt, depth: int = 0):
        """Run one Cost Management query, returning [(col_name→value)] rows.
        Splits the window on truncation and retries on throttling."""
        import time as _time
        from azure.mgmt.costmanagement.models import (
            QueryDefinition, QueryTimePeriod, QueryDataset, QueryAggregation, QueryGrouping,
        )

        query = QueryDefinition(
            type="ActualCost",
            timeframe="Custom",
            time_period=QueryTimePeriod(
                from_property=start_dt.strftime("%Y-%m-%dT00:00:00Z"),
                to=end_dt.strftime("%Y-%m-%dT23:59:59Z"),
            ),
            dataset=QueryDataset(
                granularity=granularity,
                aggregation={"totalCost": QueryAggregation(name="Cost", function="Sum")},
                grouping=[QueryGrouping(type="Dimension", name=g) for g in groupings],
            ),
        )

        last_exc = None
        for attempt in range(self._RETRY_ATTEMPTS):
            try:
                result = cm.query.usage(scope=scope, parameters=query)
                break
            except Exception as exc:
                last_exc = exc
                if "429" not in str(exc) and "Too many requests" not in str(exc):
                    raise
                if attempt == self._RETRY_ATTEMPTS - 1:
                    raise
                # Cost Management's quota window is minutes, not seconds, so a
                # blind exponential backoff gives up long before it reopens.
                # Honour Retry-After when the service sends it, and cap the wait
                # so a request can't hang indefinitely.
                retry_after = None
                response = getattr(exc, "response", None)
                if response is not None:
                    try:
                        raw = response.headers.get("Retry-After") or response.headers.get("retry-after")
                        retry_after = int(raw) if raw else None
                    except (ValueError, TypeError, AttributeError):
                        retry_after = None
                backoff = min(retry_after or 2 ** (attempt + 1), self._MAX_BACKOFF_SECONDS)
                logger.warning(
                    "Azure Cost Management throttled (429); waiting %ss (attempt %d/%d, "
                    "Retry-After=%s)",
                    backoff, attempt + 2, self._RETRY_ATTEMPTS, retry_after,
                )
                _time.sleep(backoff)
        else:  # pragma: no cover - loop always breaks or raises
            raise last_exc  # type: ignore[misc]

        cols = [c.name for c in (result.columns or [])]
        rows = [dict(zip(cols, row)) for row in (result.rows or [])]

        if getattr(result, "next_link", None):
            span_days = (end_dt - start_dt).days
            if depth < self._MAX_SPLIT_DEPTH and span_days >= 1:
                mid = start_dt + (end_dt - start_dt) / 2
                logger.info(
                    "Azure cost query truncated over %s..%s — splitting to stay complete",
                    start_dt.date(), end_dt.date(),
                )
                return (
                    self._cm_query(cm, scope, granularity, groupings, start_dt, mid, depth + 1)
                    + self._cm_query(cm, scope, granularity, groupings, mid, end_dt, depth + 1)
                )
            logger.warning(
                "Azure cost query still truncated at %s..%s after max split depth — "
                "reported totals may be incomplete.", start_dt.date(), end_dt.date(),
            )
        return rows

    async def get_cost_data(self) -> List[Dict[str, Any]]:
        """Azure Cost Management API — returns cost by service."""
        import asyncio
        from datetime import datetime, timedelta

        def _fetch():
            from azure.mgmt.costmanagement import CostManagementClient

            cm = CostManagementClient(self.auth.get_credential())
            end_dt = datetime.utcnow()
            start_dt = end_dt - timedelta(days=30)
            scope = f"/subscriptions/{self.auth.subscription_id}"
            rows = self._cm_query(
                cm, scope, None, ["ServiceName", "ResourceLocation"], start_dt, end_dt
            )
            # A split window returns the same service in several rows — combine
            # them so the caller sees one total per service/location.
            by_key: Dict[tuple, Dict[str, Any]] = {}
            for row_dict in rows:
                svc = row_dict.get("ServiceName", "Unknown")
                loc = row_dict.get("ResourceLocation") or None
                entry = by_key.setdefault((svc, loc), {
                    "resource_type": svc,
                    "resource_name": svc,
                    "region": loc,
                    "monthly_cost": 0.0,
                    "currency": row_dict.get("Currency") or None,
                })
                entry["monthly_cost"] += float(row_dict.get("Cost", 0) or 0)
            costs = list(by_key.values())
            for c in costs:
                c["monthly_cost"] = round(c["monthly_cost"], 4)
            return costs

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(query_pool(), _fetch)
        except Exception as exc:
            logger.warning("Azure Cost Management query failed: %s", exc)
            raise

    async def get_cost_by_resource(self, days: int = 30) -> Dict[str, Dict[str, Any]]:
        """Real spend per individual Azure resource over the given window, keyed
        by ARM resource ID (lower-cased), with its billed service and location.

        Cost Management reports ResourceId in a different case than ARM's
        resources.list() returns it, so keys are normalized to lower case and
        the consumer must look up the same way.

        Note on App Service: Azure bills the *App Service Plan*
        (Microsoft.Web/serverfarms), not the individual web apps that run on it,
        so the plan carries the cost and its sites legitimately report none.
        That is Azure's billing model, not missing data.
        """
        import asyncio
        from datetime import datetime, timedelta

        def _fetch():
            from azure.mgmt.costmanagement import CostManagementClient

            cm = CostManagementClient(self.auth.get_credential())
            end_dt = datetime.utcnow()
            # Cost Management hard-rejects a query definition spanning more
            # than 1 year ('Invalid query definition: The time period for
            # pulling the data cannot exceed 1 year(s)') — confirmed live: a
            # 365-day request tripped it, since end_dt carries the current
            # time-of-day and 365*24h from "now" can land a hair over Azure's
            # exact boundary. 364 days leaves a full day of margin.
            start_dt = end_dt - timedelta(days=min(days, 364))
            scope = f"/subscriptions/{self.auth.subscription_id}"
            rows = self._cm_query(
                cm, scope, None, ["ResourceId", "ServiceName", "ResourceLocation"],
                start_dt, end_dt,
            )

            by_resource: Dict[str, Dict[str, Any]] = {}
            for row_dict in rows:
                rid = row_dict.get("ResourceId")
                if not rid:
                    continue
                entry = by_resource.setdefault(str(rid).lower(), {
                    "monthly_cost": 0.0,
                    "currency": row_dict.get("Currency") or None,
                    "service": row_dict.get("ServiceName") or None,
                    "region": row_dict.get("ResourceLocation") or None,
                })
                entry["monthly_cost"] += float(row_dict.get("Cost", 0) or 0)
            for entry in by_resource.values():
                entry["monthly_cost"] = round(entry["monthly_cost"], 2)
            return by_resource

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(query_pool(), _fetch)
        except Exception as exc:
            logger.warning("Azure per-resource cost query failed: %s", exc)
            raise

    async def get_cost_report(self, days: int = 30) -> List[Dict[str, Any]]:
        """Real day-by-day, per-service spend from Azure Cost Management, for
        an arbitrary lookback window."""
        import asyncio
        from datetime import datetime, timedelta

        def _fetch():
            from azure.mgmt.costmanagement import CostManagementClient

            cm = CostManagementClient(self.auth.get_credential())
            end_dt = datetime.utcnow()
            # See get_cost_by_resource — Cost Management rejects >1 year spans.
            start_dt = end_dt - timedelta(days=min(days, 364))
            scope = f"/subscriptions/{self.auth.subscription_id}"
            rows = self._cm_query(
                cm, scope, "Daily", ["ServiceName", "ResourceLocation"], start_dt, end_dt
            )
            report = []
            for row_dict in rows:
                usage_date = row_dict.get("UsageDate")
                iso = None
                if usage_date is not None:
                    s = str(int(usage_date))
                    if len(s) == 8:
                        iso = f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
                if not iso:
                    continue
                report.append({
                    "date": iso,
                    "service": row_dict.get("ServiceName", "Unknown"),
                    "region": row_dict.get("ResourceLocation") or None,
                    "cost": round(float(row_dict.get("Cost", 0) or 0), 4),
                    "currency": row_dict.get("Currency") or None,
                })
            return report

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(query_pool(), _fetch)
        except Exception as exc:
            logger.warning("Azure Cost Management report query failed: %s", exc)
            raise

    async def get_daily_costs(self) -> List[Dict[str, Any]]:
        """Real per-day spend for the last 30 days from Azure Cost Management."""
        import asyncio
        from datetime import datetime, timedelta

        def _fetch():
            from azure.mgmt.costmanagement import CostManagementClient

            cm = CostManagementClient(self.auth.get_credential())
            end_dt = datetime.utcnow()
            start_dt = end_dt - timedelta(days=30)
            scope = f"/subscriptions/{self.auth.subscription_id}"
            rows = self._cm_query(cm, scope, "Daily", [], start_dt, end_dt)

            # A split window can yield the same day twice — sum per day so the
            # trend line never double-plots or under-reports a date.
            by_day: Dict[str, Dict[str, Any]] = {}
            for row_dict in rows:
                usage_date = row_dict.get("UsageDate")
                # UsageDate arrives as int/str yyyymmdd → ISO date
                iso = None
                if usage_date is not None:
                    s = str(int(usage_date))
                    if len(s) == 8:
                        iso = f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
                if not iso:
                    continue
                entry = by_day.setdefault(
                    iso, {"date": iso, "cost": 0.0, "currency": row_dict.get("Currency") or None}
                )
                entry["cost"] += float(row_dict.get("Cost", 0) or 0)
            daily = sorted(by_day.values(), key=lambda d: d["date"])
            for d in daily:
                d["cost"] = round(d["cost"], 4)
            return daily

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(query_pool(), _fetch)
        except Exception as exc:
            logger.warning("Azure daily cost query failed: %s", exc)
            raise
