"""Abstract base class for all cloud providers."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable, Dict, List, Optional

# Called with each batch of resources as it is discovered, so callers can
# persist incrementally and report live progress instead of waiting for the
# entire scan to finish.
OnBatch = Optional[Callable[[List[Dict[str, Any]]], Awaitable[None]]]


class BaseCloudProvider(ABC):
    """Every cloud provider must implement this contract."""

    def scan_failures(self) -> List[str]:
        """Scopes that failed to enumerate during the last scan_resources() call.

        Non-empty means the sweep was INCOMPLETE, so its result is a subset of
        reality and callers must not treat it as authoritative — in particular
        they must not prune stored resources against it, or a transient network
        or permission error silently deletes live inventory. Providers that
        cannot report this return [] and are assumed complete.
        """
        scanner = getattr(self, "scanner", None)
        return list(getattr(scanner, "scan_failures", []) or [])

    @abstractmethod
    async def authenticate(self) -> bool:
        """Validate credentials and establish an authenticated session.

        Returns True on success, raises on failure.
        """

    @abstractmethod
    async def scan_resources(self, on_batch: OnBatch = None) -> List[Dict[str, Any]]:
        """Enumerate all resources in the account/subscription/tenancy.

        If on_batch is provided, it is awaited with each batch of resources as
        they are discovered (for incremental persistence / live progress).

        Each dict must contain at minimum:
          - provider_resource_id  : str  (unique in provider)
          - resource_type         : str  (e.g. 'EC2Instance')
          - resource_name         : str
          - region_or_zone        : str
          - status                : str | None
          - ip_address            : str | None
          - config                : dict | None
          - metadata              : dict | None
          - cost_monthly          : float | None
          - tags                  : dict | None
          - raw_data              : dict
        """

    @abstractmethod
    async def get_resource_details(self, resource_id: str) -> Dict[str, Any]:
        """Return full details for a single resource by its provider ID."""

    @abstractmethod
    async def get_cost_data(self) -> List[Dict[str, Any]]:
        """Return cost breakdown per resource / service.

        Each dict must contain:
          - resource_type   : str
          - resource_name   : str
          - region          : str
          - monthly_cost    : float
          - currency        : str
        """
