"""Provider adapters for audit-event collection.

One entry point — `adapter_for` — so nothing above this package has to know
which providers exist or how their names are spelled in `cloud_accounts`.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Type

from app.events.adapters.base import CollectedEvent, EventAdapter, ScopeResult

# The provider strings that appear in cloud_accounts.provider. "Oracle" and
# "OCI" are both on file (the account form has used both labels), so both map
# here rather than making callers normalize first — the same map the discovery
# worker keeps for the inventory providers.
_ADAPTERS: Dict[str, str] = {
    "AWS": "aws",
    "AZURE": "azure",
    "ORACLE": "oci",
    "OCI": "oci",
}


def adapter_class_for(provider: str) -> Optional[Type[EventAdapter]]:
    """The adapter class for a provider name, or None if unsupported.

    Imported lazily: each adapter pulls in its provider SDK at import time, and
    a deployment missing one SDK should lose that one provider rather than fail
    to start the whole service.
    """
    key = _ADAPTERS.get((provider or "").strip().upper())
    if key == "aws":
        from app.events.adapters.aws_adapter import AWSEventAdapter

        return AWSEventAdapter
    if key == "azure":
        from app.events.adapters.azure_adapter import AzureEventAdapter

        return AzureEventAdapter
    if key == "oci":
        from app.events.adapters.oci_adapter import OCIEventAdapter

        return OCIEventAdapter
    return None


def adapter_for(
    provider: str, credentials: Dict[str, Any], *, collect_read_only: bool = False
) -> Optional[EventAdapter]:
    cls = adapter_class_for(provider)
    if cls is None:
        return None
    return cls(credentials, collect_read_only=collect_read_only)


def provider_label(provider: str) -> str:
    """The canonical short label used on events and in the UI.

    `cloud_accounts` stores "Oracle" for OCI, but every audit surface says OCI,
    so the event rows carry OCI and this is the single place that translation
    happens.
    """
    key = _ADAPTERS.get((provider or "").strip().upper())
    return {"aws": "AWS", "azure": "Azure", "oci": "OCI"}.get(key, provider)


def provider_retention_days(provider: str) -> Optional[int]:
    cls = adapter_class_for(provider)
    return cls.provider_retention_days if cls else None


__all__ = [
    "CollectedEvent",
    "EventAdapter",
    "ScopeResult",
    "adapter_class_for",
    "adapter_for",
    "provider_label",
    "provider_retention_days",
]
