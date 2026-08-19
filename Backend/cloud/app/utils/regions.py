"""Region normalisation.

`cloud_resources.region_or_zone` was being filled with three different kinds of
value, so the dashboard's "Geographic / Region Breakdown" listed five entries for
a tenancy that has two regions:

  ap-mumbai-1                real region
  hpAD:AP-MUMBAI-1-AD-1      an OCI *availability domain*
  ap-south-1a                an AWS *availability zone*
  global                     our own placeholder for non-regional resources

A region, an availability domain and an availability zone are three different
levels of the same hierarchy, and mixing them in one column means no consumer can
group by region correctly. These helpers reduce any of them to the region, so the
column holds one kind of value and the finer-grained placement is kept separately
in config (`availability_domain` / `availability_zone`).

`global` is deliberately preserved rather than dropped: IAM in both AWS and OCI
genuinely has no region, and hiding those resources would be worse than labelling
them. It is our label for "not regional", not a provider region name — callers
should display it as such.
"""
from __future__ import annotations

import re
from typing import Optional

#: Value used for resources that genuinely have no region (IAM, tenancy-level).
GLOBAL = "global"

# OCI availability domain: "<tenancy-prefix>:<REGION>-AD-<n>", e.g.
# "hpAD:AP-MUMBAI-1-AD-1". The prefix is per tenancy and carries no meaning here.
_OCI_AD = re.compile(r"^[^:]*:(?P<region>.+?)-AD-\d+$", re.IGNORECASE)

# AWS availability zone: the region plus a single trailing letter, e.g.
# "ap-south-1a". Anchored on "<text>-<digit>" so a region like "ap-south-1" is
# left alone and only a real zone suffix is trimmed.
_AWS_AZ = re.compile(r"^(?P<region>[a-z]{2,4}-[a-z0-9-]+-\d+)[a-z]$", re.IGNORECASE)


def normalize_region(value: Optional[str]) -> Optional[str]:
    """Reduce a region / availability domain / availability zone to its region.

    >>> normalize_region("hpAD:AP-MUMBAI-1-AD-1")
    'ap-mumbai-1'
    >>> normalize_region("ap-south-1b")
    'ap-south-1'
    >>> normalize_region("ap-mumbai-1")
    'ap-mumbai-1'
    >>> normalize_region("global")
    'global'
    >>> normalize_region("centralindia")
    'centralindia'
    """
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    if v.lower() == GLOBAL:
        return GLOBAL

    m = _OCI_AD.match(v)
    if m:
        return m.group("region").lower()

    m = _AWS_AZ.match(v)
    if m:
        return m.group("region").lower()

    return v.lower() if v.isupper() else v


def is_global(value: Optional[str]) -> bool:
    return (value or "").strip().lower() == GLOBAL
