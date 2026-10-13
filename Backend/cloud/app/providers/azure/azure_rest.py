"""Plain REST calls to Azure, for the handful of APIs this service has no SDK for.

Management groups, subscription-level effective permissions, App Service
certificates and the Key Vault data plane each have an SDK package; installing
four more packages to make a dozen GETs is a poor trade on a venv that already
suffers ghost installs (see dev-environment-quirks), so these go over HTTPS
with the same ClientSecretCredential every other Azure call uses.

The one thing this module must get right is the error. Azure answers a
refused request with a JSON envelope whose `code` and `innererror.code` are
what distinguish "you lack the role" (ForbiddenByRbac) from "you lack the
access-policy permission" (ForbiddenByPolicy) from "the vault's firewall
refused this network" (ForbiddenByFirewall). Those need three different fixes,
so `AzureRestError` keeps every part rather than collapsing to a status code.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger("cloud_svc.azure.rest")

ARM = "https://management.azure.com"
ARM_SCOPE = "https://management.azure.com/.default"
VAULT_SCOPE = "https://vault.azure.net/.default"

_TIMEOUT = (10, 45)  # (connect, read) seconds
_MAX_PAGES = 200


class AzureRestError(Exception):
    def __init__(self, status: Optional[int], code: Optional[str], message: str,
                 inner_code: Optional[str] = None, url: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.inner_code = inner_code
        self.message = message
        self.url = url

    def __str__(self) -> str:
        bits = [f"HTTP {self.status}" if self.status else "no response"]
        if self.code:
            bits.append(self.code)
        if self.inner_code and self.inner_code != self.code:
            bits.append(self.inner_code)
        return f"{' / '.join(bits)}: {self.message}"


def ssl_verify() -> bool | str:
    """Same switch the AWS path honours (CLOUD_SSL_VERIFY / a CA bundle)."""
    if os.getenv("CLOUD_SSL_VERIFY", "true").strip().lower() in ("false", "0", "no"):
        return False
    return os.getenv("REQUESTS_CA_BUNDLE") or os.getenv("AZURE_CA_BUNDLE") or True


def bearer(credential, scope: str = ARM_SCOPE) -> str:
    return credential.get_token(scope).token


def _raise_for(resp: requests.Response) -> None:
    if resp.status_code < 400:
        return
    code = inner = None
    message = resp.text[:800] if resp.text else resp.reason
    try:
        body = resp.json()
        err = body.get("error") if isinstance(body, dict) else None
        if isinstance(err, dict):
            code = err.get("code")
            message = err.get("message") or message
            ie = err.get("innererror") or err.get("innerError")
            if isinstance(ie, dict):
                inner = ie.get("code")
    except ValueError:
        pass
    raise AzureRestError(resp.status_code, code, str(message)[:1200], inner, resp.url)


def get(url: str, token: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    try:
        resp = requests.get(url, headers={"Authorization": f"Bearer {token}"},
                            params=params, timeout=_TIMEOUT, verify=ssl_verify())
    except requests.RequestException as exc:
        raise AzureRestError(None, type(exc).__name__, str(exc)[:600], url=url) from exc
    _raise_for(resp)
    try:
        return resp.json()
    except ValueError as exc:
        raise AzureRestError(resp.status_code, "InvalidJson",
                             "The response was not JSON.", url=url) from exc


def get_all(url: str, token: str, params: Optional[Dict[str, Any]] = None,
            *, item_key: str = "value") -> List[Dict[str, Any]]:
    """Every item across `nextLink` pages. A failure on page N raises — a
    listing that silently stops halfway is the one thing that must not be
    stored as complete."""
    items: List[Dict[str, Any]] = []
    page = get(url, token, params)
    for _ in range(_MAX_PAGES):
        items.extend(page.get(item_key) or [])
        nxt = page.get("nextLink") or page.get("@odata.nextLink")
        if not nxt:
            return items
        page = get(nxt, token)
    raise AzureRestError(None, "TooManyPages",
                         f"Stopped after {_MAX_PAGES} pages; the listing is incomplete.",
                         url=url)
