"""Relationship rules — which provider field means which edge.

Each rule names one field the scanners actually write, the edge it produces, and
what to say when the identifier it holds does not resolve. Rules are data, so
adding a relationship is one entry here rather than another branch in the
resolver, and the evidence string shown in the UI is generated from the same
declaration that drew the edge — the two cannot describe different fields.

## Every rule is grounded in a field that exists

Each `field` below was verified against the three scanners in
`app/providers/{aws,azure,oci}` before it was added. A rule for a field nothing
writes is not harmless: it is dead code that looks like coverage.

## Rules that always dangle are still worth having — once

The original resolver deliberately had no rule for `config.image_id`, because
machine images are not collected and every instance would have registered a
permanent unresolved reference, drowning the real gaps. That reasoning is kept,
but generalised rather than applied by omission: a rule may target a type no
scanner collects (an OCI gateway, a Vault key) as long as its `gap` is listed in
`UNCOLLECTED_TARGETS`, which files the reference under "type not collected"
instead of "target missing". The relationship is then reported honestly as a
known product limitation, which is more useful than pretending the field is not
there. `image_id` stays excluded because an image is not part of the topology in
the first place.
"""
from __future__ import annotations

from typing import Dict, List, NamedTuple, Optional, Sequence

from app.topology.model import (
    ATTACHED,
    CONTAINS,
    ENCRYPTED_BY,
    MANAGED_BY,
    NETWORK,
    PROTECTS,
    ROLE,
    ROUTES_TO,
    SECURITY,
)


class Rule(NamedTuple):
    """One field-to-edge mapping.

    source_of_truth  where to read: "config" or "metadata"
    field            the key within it
    kind             the relationship type
    label            the edge's human label ("in subnet", "guarded by")
    gap              what to report when the identifier does not resolve;
                     None means the reference is not worth reporting
    expect_type      resource type to prefer when an id lookup misses and the
                     value turns out to be a bare name
    applies_to       restrict to these resource types; None means any
    reverse          when True the edge runs target -> this resource, because
                     the field names an upstream producer rather than a
                     downstream dependency
    """

    source_of_truth: str
    field: str
    kind: str
    label: str
    gap: Optional[str] = None
    expect_type: Optional[str] = None
    applies_to: Optional[frozenset] = None
    reverse: bool = False

    @property
    def evidence_field(self) -> str:
        return f"{self.source_of_truth}.{self.field}"


# ── The rule table ───────────────────────────────────────────────────────────
# Ordered for readability only; the resolver applies all of them to every
# resource and the edge set does not depend on the order.

RULES: Sequence[Rule] = (
    # ── Network containment ──────────────────────────────────────────────────
    Rule("config", "vpc_id", NETWORK, "in network",
         gap="network (VPC/VCN/VNet) not discovered"),
    Rule("config", "vcn_id", NETWORK, "in network",
         gap="network (VPC/VCN/VNet) not discovered"),
    Rule("config", "virtual_network_id", NETWORK, "in network",
         gap="network (VPC/VCN/VNet) not discovered"),
    Rule("config", "subnet_id", NETWORK, "in subnet",
         gap="subnet not discovered"),
    Rule("config", "subnet_ids", NETWORK, "in subnet",
         gap="subnet not discovered"),

    # ── Security controls ────────────────────────────────────────────────────
    # Five field names for the same concept across three providers. `nsg_id`
    # (singular) is kept although nothing writes it today: it costs nothing and
    # the OCI scanner's own key was once assumed to be that, which is how OCI
    # compute silently had no security edges at all for a while.
    Rule("config", "security_group_ids", SECURITY, "guarded by",
         gap="security group / NSG / Security List not discovered"),
    Rule("config", "security_groups", SECURITY, "guarded by",
         gap="security group / NSG / Security List not discovered"),
    Rule("config", "nsg_id", SECURITY, "guarded by",
         gap="security group / NSG / Security List not discovered"),
    Rule("config", "nsg_ids", SECURITY, "guarded by",
         gap="security group / NSG / Security List not discovered"),
    Rule("config", "network_security_group_id", SECURITY, "guarded by",
         gap="security group / NSG / Security List not discovered"),
    Rule("config", "security_list_ids", SECURITY, "guarded by",
         gap="security group / NSG / Security List not discovered"),

    # ── Routing ──────────────────────────────────────────────────────────────
    Rule("config", "route_table_id", NETWORK, "routes via",
         gap="route table not discovered"),
    # An Azure subnet's egress NAT gateway. Collected by the generic ARM sweep,
    # so this normally resolves.
    Rule("config", "nat_gateway_id", ROUTES_TO, "egresses via",
         gap="NAT gateway not discovered"),

    # ── Identity ─────────────────────────────────────────────────────────────
    # Azure's config["identity_id"] is deliberately absent: it is a principal
    # GUID, not a resource ID, so it can never resolve against an inventory of
    # resources and only ever registered a phantom gap.
    Rule("config", "role_arn", ROLE, "assumes", gap="IAM role not discovered"),
    Rule("config", "role", ROLE, "assumes", gap="IAM role not discovered"),

    # ── Azure VM wiring ──────────────────────────────────────────────────────
    Rule("config", "nic_ids", NETWORK, "has interface",
         gap="network interface not discovered"),
    Rule("config", "os_disk_id", ATTACHED, "has OS disk",
         gap="managed disk not discovered"),
    Rule("config", "data_disk_ids", ATTACHED, "has data disk",
         gap="managed disk not discovered"),
    Rule("config", "availability_set_id", CONTAINS, "in availability set",
         gap="availability set not discovered"),
    Rule("config", "public_ip_ids", NETWORK, "exposes",
         gap="public IP not discovered"),

    # ── Lifecycle ownership ──────────────────────────────────────────────────
    Rule("config", "managed_by", MANAGED_BY, "managed by",
         gap="managing resource not discovered"),

    # ── OCI: a function's application ────────────────────────────────────────
    Rule("config", "application_id", CONTAINS, "in application",
         gap="OCI function application not discovered"),

    # ── OCI: a VCN's default route table, security list and DHCP options ─────
    # The VCN model names all three, and all three are collected as resources,
    # so these are exact resolvable edges that nothing was drawing.
    Rule("config", "default_route_table_id", NETWORK, "default route table",
         gap="route table not discovered", applies_to=frozenset({"VCN"})),
    Rule("config", "default_security_list_id", SECURITY, "default security list",
         gap="security group / NSG / Security List not discovered",
         applies_to=frozenset({"VCN"})),
    Rule("config", "default_dhcp_options_id", NETWORK, "default DHCP options",
         gap="DHCP option set not discovered", applies_to=frozenset({"VCN"})),

    # ── OCI: DRG attachment joins a VCN to a dynamic routing gateway ─────────
    Rule("config", "attached_network_id", NETWORK, "attaches network",
         gap="network (VPC/VCN/VNet) not discovered",
         applies_to=frozenset({"DrgAttachment"})),
    Rule("config", "drg_id", ROUTES_TO, "attaches to DRG",
         gap="OCI DRG", applies_to=frozenset({"DrgAttachment"})),
    Rule("config", "gateway_id", ROUTES_TO, "terminates on",
         gap="OCI DRG", applies_to=frozenset({"VirtualCircuit"})),

    # ── OCI: a web application firewall in front of a load balancer ──────────
    # The firewall names the balancer it protects, so the edge runs
    # firewall -> balancer, which is the direction traffic is inspected.
    Rule("config", "load_balancer_id", PROTECTS, "protects",
         gap="load balancer not discovered",
         applies_to=frozenset({"WebAppFirewall"})),
    Rule("config", "web_app_firewall_policy_id", SECURITY, "uses WAF policy",
         gap="WAF policy", applies_to=frozenset({"WebAppFirewall"})),

    # ── Customer-managed encryption keys ─────────────────────────────────────
    # Vault keys are not collected as resources yet, so this reports as a known
    # limitation rather than an incident — but the reference itself is real and
    # security-relevant, which is why it is reported at all.
    Rule("config", "kms_key_id", ENCRYPTED_BY, "encrypted with",
         gap="KMS / Vault key"),

    # ── AWS: a VPC's DHCP option set ─────────────────────────────────────────
    # In metadata, not config, and AWS does not collect option sets as
    # resources — so this lands in the "type not collected" bucket.
    Rule("metadata", "dhcp_options_id", NETWORK, "uses DHCP options",
         gap="AWS DHCP option set", applies_to=frozenset({"VPC"})),

    # ── Load balancer backends resolved to instance ids ──────────────────────
    Rule("config", "backend_instance_ids", ROUTES_TO, "forwards to",
         gap="load balancer backend not discovered"),
)


# Rules keyed by the field they read, so the resolver walks a resource's config
# once instead of the whole rule table per resource. Several rules can share a
# field name (none do today, but `role` and `role_arn` are close enough that a
# future overlap is plausible), so the value is a list.
RULES_BY_FIELD: Dict[str, Dict[str, List[Rule]]] = {"config": {}, "metadata": {}}
for _rule in RULES:
    RULES_BY_FIELD[_rule.source_of_truth].setdefault(_rule.field, []).append(_rule)


# ── Fields deliberately NOT turned into edges ────────────────────────────────
# Documented rather than merely absent, so the next person to notice one of
# these does not "fix" it back into a permanent phantom gap. Surfaced by the
# diagnostics endpoint.

EXCLUDED_FIELDS: Dict[str, str] = {
    "config.image_id": (
        "A machine image is not part of the running topology and is not "
        "collected as a resource, so every instance would register a permanent "
        "unresolved reference."
    ),
    "config.identity_id": (
        "Azure's managed-identity field holds a principal GUID, not a resource "
        "ID. It can never match an inventory of resources."
    ),
    "config.target_groups": (
        "AWS reports target group NAMES here, not ARNs, and names are not "
        "authoritative identity. The balancer's resolved backend instance ids "
        "are used instead, which is the same relationship stated exactly."
    ),
    "config.certificate_id": (
        "Load balancer certificates are not collected as resources, and unlike "
        "an encryption key a certificate is not a topology participant."
    ),
    "config.attached_storage_gb": "A size, not a reference.",
    "config.member_instance_count": "A count, not a reference.",
    "config.role_id": "The role's own identifier, not a reference to another resource.",
}
