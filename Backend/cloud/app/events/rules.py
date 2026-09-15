"""Event classification rules — data, not code.

Every collected event gets a category, an action verb and a risk level. Those
three drive the summary cards, the category chips, the risk filter and every
"show me what matters" path in the UI, so how they are decided has to be
inspectable and adjustable without editing Python.

Hence this file holds *tables*, and app/events/classification.py holds the (very
small) engine that walks them. An operator who disagrees that CreateBucket is
MEDIUM can point EVENT_RULES_FILE at a JSON file and change it; the shipped
defaults below are the starting position, not a hardcoded verdict.

Three layers, applied in order:

1.  **ACTION_PATTERNS / CATEGORY_PATTERNS** — mechanical derivation from the
    provider's own operation string. "DeleteBucket" is a Delete on Storage
    whichever cloud it came from.
2.  **BASE_RISK_BY_ACTION** — the floor. Reading is INFO, deleting is HIGH.
3.  **RISK_RULES** — the specific things that genuinely matter, evaluated
    first-match-wins and most-specific-first. Each carries an `id` and a
    `why`, which are stored on the event as `risk_reason`, so a CRITICAL badge
    can always be traced back to the rule that raised it.

The rules in layer 3 are the list from the specification's "high-risk events"
section, written against real provider operation names rather than prose.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List

logger = logging.getLogger("cloud_svc.events.rules")


# ── Layer 1a: action verb ─────────────────────────────────────────────────────
# Ordered: the first pattern found in the operation name wins, so the longer,
# more specific fragments must come before the short ones ("Disassociate"
# before "Associate", "Deregister" before "Register", "Detach" before "Attach").
# A plain substring scan is used rather than regex — these are all literal
# fragments and the scan runs once per event.
ACTION_PATTERNS: List[tuple] = [
    ("Disassociate", "Disassociate"),
    ("Associate", "Associate"),
    ("Deregister", "Detach"),
    ("Unregister", "Detach"),
    ("Detach", "Detach"),
    ("Attach", "Attach"),
    ("Reboot", "Reboot"),
    ("Restart", "Reboot"),
    ("Terminate", "Delete"),
    ("Delete", "Delete"),
    ("Remove", "Delete"),
    ("Destroy", "Delete"),
    ("Purge", "Delete"),
    ("Revoke", "Revoke"),
    ("Deauthorize", "Revoke"),
    ("Authorize", "Authorize"),
    ("Grant", "Authorize"),
    ("Deactivate", "Disable"),
    ("Disable", "Disable"),
    ("Activate", "Enable"),
    ("Enable", "Enable"),
    ("Signin", "Login"),
    ("SignIn", "Login"),
    ("ConsoleLogin", "Login"),
    ("Login", "Login"),
    ("Authenticate", "Login"),
    ("Logout", "Logout"),
    ("Signout", "Logout"),
    ("Scale", "Scale"),
    ("Resize", "Scale"),
    ("Deploy", "Deploy"),
    ("Publish", "Deploy"),
    ("Invoke", "Invoke"),
    ("Execute", "Invoke"),
    ("Run", "Invoke"),
    ("Start", "Start"),
    ("PowerOn", "Start"),
    ("Launch", "Start"),
    ("Stop", "Stop"),
    ("PowerOff", "Stop"),
    ("Shutdown", "Stop"),
    ("Suspend", "Stop"),
    ("Create", "Create"),
    ("Register", "Create"),
    ("Add", "Create"),
    ("Import", "Create"),
    ("Put", "Update"),
    ("Update", "Update"),
    ("Modify", "Modify"),
    ("Change", "Modify"),
    ("Patch", "Update"),
    ("Set", "Update"),
    ("Replace", "Update"),
    ("Move", "Update"),
    ("Tag", "Update"),
    ("Untag", "Update"),
    ("Restore", "Update"),
    ("Get", "Read"),
    ("List", "Read"),
    ("Describe", "Read"),
    ("Read", "Read"),
    ("Lookup", "Read"),
    ("Search", "Read"),
    ("Query", "Read"),
    ("Head", "Read"),
    ("Validate", "Read"),
    ("Check", "Read"),
]

# Azure names its operations by REST verb suffix rather than by an English
# verb, so it needs its own map: ".../write" is a create-or-update.
AZURE_VERB_SUFFIX: Dict[str, str] = {
    "write": "Update",
    "delete": "Delete",
    "read": "Read",
    "action": "Invoke",
    "start": "Start",
    "stop": "Stop",
    "restart": "Reboot",
    "deallocate": "Stop",
    "powerof": "Stop",
    "listkeys": "Read",
    "regeneratekey": "Modify",
}

# OCI reports an explicit type on the event itself
# ("com.oraclecloud.virtualnetwork.createvcn"), and also a request action verb.
OCI_REQUEST_ACTION: Dict[str, str] = {
    "GET": "Read",
    "HEAD": "Read",
    "POST": "Create",
    "PUT": "Update",
    "PATCH": "Update",
    "DELETE": "Delete",
}


# ── Layer 1b: category ────────────────────────────────────────────────────────
# Matched against a lowercased haystack of "source + operation + event name +
# resource type + resource id", first hit wins.
#
# Two things about the ordering and the fragments, both learned by getting them
# wrong first:
#
# 1.  **Order is specificity, not importance.** Network sits above IAM because
#     "networkSecurityGroups" and "AuthorizeSecurityGroupIngress" both contain
#     the word "group": with IAM first, every firewall-rule change in all three
#     clouds was categorised as IAM. The most specific matcher has to win, and
#     "securitygroup" is more specific than anything IAM can say about it.
#
# 2.  **No fragment may be a common English word.** Bare "user", "group" and
#     "policy" were in the IAM list and matched a bucket policy, a network
#     security group and an autoscaling group. Every IAM fragment below is
#     either a service name, a compound noun, or a whole operation name.
CATEGORY_PATTERNS: List[tuple] = [
    # Authentication first: a login IS an IAM-adjacent event, but
    # "Authentication" is the more useful answer for it.
    ("Authentication", (
        "consolelogin", "signin", "sign-in", "authenticate", "getsessiontoken",
        "assumerolewithsaml", "assumerolewithwebidentity", "mfa",
        "microsoft.aadiam", "logout", "getfederationtoken",
    )),
    ("Network", (
        "securitygroup", "vpc", "subnet", "routetable", "networkacl",
        "internetgateway", "natgateway", "elasticloadbalancing", "loadbalancer",
        "microsoft.network", "vcn", "networksecuritygroup", "seclist",
        "securityrule", "securitylist", "route53", "dns", "firewall", "peering",
        "vpn", "directconnect", "expressroute", "networkinterface", "vnic",
        "publicip", "elasticip", "drg.", "ipsec", "networkloadbalancer",
    )),
    ("Security", (
        "kms", "keyvault", "vaults/", "guardduty", "securityhub",
        "inspector", "macie", "shield", "waf", "microsoft.security",
        "cloudguard", "certificate", "encryption", "bastion", "acmpca",
        "secretsmanager", "getsecretvalue", "ocid1.vault", "ocid1.key",
        "keymanagement", "wafv2",
        # Operations that hand back credential material. Categorised as
        # Security rather than as the service that hosts them, because "who
        # read a deployment credential" is a security question wherever the
        # credential lives. Found on live Azure data: an App Service
        # publish-profile read was landing under Compute.
        "listpublishingcredentials", "publishingcredentials", "publishxml",
        "listkeys", "regeneratekey", "listaccountsas", "listservicesas",
        "listconnectionstrings",
    )),
    ("IAM", (
        "iam", "sts.", "assumerole", "roleassignment", "roledefinition",
        "serviceprincipal", "dynamicgroup", "microsoft.managedidentity",
        "identitydomain", "identityprovider", "graph.microsoft",
        # Whole operation names rather than the nouns inside them, so a bucket
        # policy or a network security group cannot match.
        "createuser", "deleteuser", "updateuser", "listusers", "getuser",
        "creategroup", "deletegroup", "updategroup", "listgroups",
        "addusertogroup", "removeuserfromgroup", "userpolicy", "rolepolicy",
        "grouppolicy", "policyversion", "permissionsboundary", "loginprofile",
        "accesskey", "apikey", "authtoken", "createrole", "deleterole",
        "updaterole", "passwordpolicy", "smtpcredential", "ocid1.user",
        "ocid1.group", "ocid1.policy",
    )),
    ("Authorization", (
        "authorizationfailed", "checkaccess", "simulateprincipalpolicy",
        "microsoft.authorization/", "getpolicy", "getaccountauthorizationdetails",
    )),
    ("Storage", (
        "s3.amazonaws.com", "s3-", "bucket", "objectstorage", "microsoft.storage",
        "storageaccount", "elasticfilesystem", "fsx", "filesystem", "blob",
        "fileshare", "volume", "snapshot", "disk", "backup", "glacier",
        # NOT bare "ebs" or "efs" — three letters is short enough to land
        # inside an unrelated word ("ebs" matched "stopWEBSite"). AWS names the
        # types in full anyway.
        "ebsvolume", "ec2snapshot", "bootvolume",
    )),
    ("Database", (
        "rds", "dynamodb", "elasticache", "redshift", "documentdb", "neptune",
        "microsoft.sql", "microsoft.dbfor", "cosmosdb", "microsoft.cache",
        "database", "autonomous", "mysql", "postgres", "oracledatabase",
        "dbsystem",
    )),
    ("Compute", (
        "ec2.amazonaws.com", "instance", "autoscaling", "lambda", "ecs", "eks",
        "batch", "microsoft.compute", "virtualmachine", "microsoft.web",
        "appservice", "functionapp", "microsoft.containerservice", "container",
        "oke", "cluster", "scalingpolicy", "image",
    )),
    ("Monitoring", (
        "cloudwatch", "monitoring", "microsoft.insights", "alarm", "metric",
        "alert", "notification", "notifications", "sns", "healthchecks",
        # OCI's Notification Service is literally "ons", which is far too short
        # to stand alone — it matched "subscriptiONS" inside every Azure ARM
        # resource id. Anchored forms only.
        "ons.", "oci_ons", "onstopic",
    )),
    ("Logging", (
        "cloudtrail", "logs.amazonaws.com", "loggroup", "diagnosticsettings",
        "microsoft.operationalinsights", "loganalytics", "logging", "auditevents",
    )),
    ("Billing", (
        "billing", "budgets", "ce.amazonaws.com", "costexplorer", "pricing",
        "microsoft.consumption", "microsoft.billing", "usageapi", "invoice",
        # NOT bare "subscription": every Azure ARM resource id begins
        # "/subscriptions/", so it matched every Azure event ever collected and
        # only lost to Compute/Storage by ordering luck.
        "subscriptionmapping", "microsoft.subscription", "commitment",
    )),
    ("DataAccess", (
        "getobject", "putobject", "deleteobject", "getsecretvalue",
        "getitem", "putitem", "query", "scan", "download", "upload",
    )),
    ("ResourceManagement", (
        "cloudformation", "microsoft.resources/", "resourcemanager", "stack",
        "terraform",
        # NOT bare "resourcegroup" (in every ARM id) and NOT bare "tag" (it
        # matched "taggedTrafficConsumers"). Whole operations instead.
        "resourcegroups/write", "resourcegroups/delete", "createtags",
        "deletetags", "tagresource", "untagresource", "tags/write",
    )),
    ("Configuration", (
        "config", "setting", "parameter", "microsoft.policyinsights",
        "microsoft.authorization/policy", "quota", "limit",
    )),
]


# ── Layer 2: the risk floor ───────────────────────────────────────────────────
# What an operation is worth before anything specific is known about it. This is
# a floor, never a ceiling: layer 3 can only raise a level, never lower one,
# because a rule that quietly demotes a destructive call is how a real incident
# gets filtered off the first page.
BASE_RISK_BY_ACTION: Dict[str, str] = {
    "Read": "INFO",
    "Login": "LOW",
    "Logout": "INFO",
    "Start": "LOW",
    "Stop": "LOW",
    "Reboot": "LOW",
    "Invoke": "LOW",
    "Associate": "MEDIUM",
    "Disassociate": "MEDIUM",
    "Attach": "MEDIUM",
    "Detach": "MEDIUM",
    "Create": "MEDIUM",
    "Update": "MEDIUM",
    "Modify": "MEDIUM",
    "Scale": "MEDIUM",
    "Deploy": "MEDIUM",
    "Enable": "MEDIUM",
    "Disable": "HIGH",
    "Authorize": "HIGH",
    "Revoke": "HIGH",
    "Delete": "HIGH",
    "Other": "LOW",
}

# Categories where any write is worth more than the verb alone implies.
# A Create in IAM is not the same thing as a Create in Monitoring.
CATEGORY_RISK_FLOOR: Dict[str, str] = {
    "IAM": "HIGH",
    "Security": "HIGH",
    "Authorization": "HIGH",
    "Network": "MEDIUM",
    "Logging": "HIGH",
}


# ── Layer 3: the rules that matter ────────────────────────────────────────────
# First match wins, so these are ordered most-specific first. Each rule may
# match on:
#
#   provider          exact, "AWS" | "Azure" | "OCI"
#   name_any          case-insensitive substring of event_name / api_operation
#   source_any        case-insensitive substring of event_source
#   actor_type_any    exact match against the normalized actor type
#   status_any        exact match against the normalized status
#   payload_any       case-insensitive substring of the serialized request
#                     parameters — this is how "opened to 0.0.0.0/0" is
#                     detected, since the operation name alone cannot say it
#   category_any      exact match against the derived category
#
# All present conditions must hold (AND). Absent conditions are not checked.
RISK_RULES: List[Dict[str, Any]] = [
    # ── Root / break-glass ───────────────────────────────────────────────────
    {
        "id": "root-account-usage",
        "risk": "CRITICAL",
        "why": "The account root / tenancy administrator was used directly. Root should be "
               "break-glass only, so every use is worth explaining.",
        "match": {"actor_type_any": ["RootAccount"]},
    },
    # ── Audit and logging controls ───────────────────────────────────────────
    {
        "id": "audit-logging-disabled",
        "risk": "CRITICAL",
        "why": "An audit or logging control was stopped, deleted or reconfigured. This is the "
               "step that makes later activity invisible, so it outranks the activity itself.",
        "match": {
            "name_any": [
                "stoplogging", "deletetrail", "updatetrail", "puteventselectors",
                "deleteflowlogs", "deletelogGroup", "deleteloggroup",
                "diagnosticsettings/delete", "diagnosticsettings/write",
                "microsoft.insights/diagnosticsettings/delete",
                "deletelogsavedsearch", "deleteloggroup", "updatelog",
                "deletelog", "deleteunifiedagentconfiguration",
                "deletediagnosticsetting", "deletedatacollectionrule",
            ],
        },
    },
    {
        "id": "audit-config-changed",
        "risk": "CRITICAL",
        "why": "The audit configuration itself was changed.",
        "match": {"name_any": ["updateauditconfiguration", "putauditconfiguration",
                               "updateretentionperiod"]},
    },
    # ── Encryption / key material ────────────────────────────────────────────
    {
        "id": "key-or-secret-deleted",
        "risk": "CRITICAL",
        "why": "Key or secret material was scheduled for deletion or destroyed. Data encrypted "
               "under it may become permanently unreadable.",
        "match": {
            "name_any": [
                "scheduledkeydeletion", "schedulekeydeletion", "deletekey",
                "deletesecret", "purgedeletedsecret", "purgedeletedkey",
                "scheduleKeyDeletion", "schedulevaultdeletion", "deletevault",
                "purgedeletedvault", "deletealias",
            ],
        },
    },
    {
        "id": "encryption-disabled",
        "risk": "CRITICAL",
        "why": "Encryption was disabled or a key was disabled, which removes protection from "
               "data already at rest.",
        "match": {"name_any": ["disablekey", "disableencryption", "deletebucketencryption",
                               "removeencryption", "disablekeyrotation"]},
    },
    # ── Privilege escalation ─────────────────────────────────────────────────
    {
        "id": "admin-privilege-granted",
        "risk": "CRITICAL",
        "why": "An administrator-level privilege was granted. This is the classic privilege "
               "escalation step.",
        "match": {"payload_any": ["administratoraccess", "arn:aws:iam::aws:policy/administrator",
                                  "\"owner\"", "roledefinitionid/8e3af657",
                                  "b24988ac-6180-42a0-ab88-20f7382dd24c",
                                  "administrators", "tenancy-admin"]},
    },
    {
        "id": "iam-policy-changed",
        "risk": "CRITICAL",
        "why": "An IAM policy, role or permission boundary was changed — who can do what in "
               "this account is no longer what it was.",
        "match": {
            "name_any": [
                "putuserpolicy", "putrolepolicy", "putgrouppolicy", "attachuserpolicy",
                "attachrolepolicy", "attachgrouppolicy", "detachuserpolicy",
                "detachrolepolicy", "detachgrouppolicy", "createpolicyversion",
                "setdefaultpolicyversion", "putpermissionsboundary",
                "updateassumerolepolicy", "roleassignments/write",
                "roleassignments/delete", "roledefinitions/write",
                "createpolicy", "updatepolicy", "deletepolicy",
                "policyassignments/write", "policyassignments/delete",
            ],
        },
    },
    {
        "id": "mfa-disabled",
        "risk": "CRITICAL",
        "why": "Multi-factor authentication was removed or deactivated for a principal.",
        "match": {"name_any": ["deactivatemfadevice", "deletevirtualmfadevice",
                               "disablemfa", "deletemfadevice", "removemfa"]},
    },
    # ── Public exposure ──────────────────────────────────────────────────────
    {
        "id": "opened-to-internet",
        "risk": "CRITICAL",
        "why": "A network rule was written with an all-addresses source (0.0.0.0/0 or ::/0), "
               "which exposes the target to the whole internet.",
        "match": {"payload_any": ["0.0.0.0/0", "::/0", "\"*\"", "internet"],
                  "category_any": ["Network"]},
    },
    {
        "id": "public-storage-enabled",
        "risk": "CRITICAL",
        "why": "Public access was granted to storage, or a public-access block was removed.",
        "match": {
            "name_any": [
                "deletebucketpublicaccessblock", "putbucketpublicaccessblock",
                "putbucketacl", "putbucketpolicy", "deletebucketpolicy",
                "createpreauthenticatedrequest", "updatebucket",
                "blobservices/containers/write", "allowblobpublicaccess",
            ],
        },
    },
    {
        "id": "firewall-or-security-control-disabled",
        "risk": "CRITICAL",
        "why": "A protective control (firewall, WAF, threat detection) was disabled or deleted.",
        "match": {
            "name_any": [
                "deletewebacl", "disassociatewebacl", "deletefirewall",
                "deletefirewallpolicy", "disablesecurityhub", "deletedetector",
                "disablecloudguard", "deletetarget", "disableautoprotection",
                "deletenetworkfirewall", "updatesecuritypolicy",
                "microsoft.security/pricings/write",
            ],
        },
    },
    # ── Credentials ──────────────────────────────────────────────────────────
    {
        "id": "access-key-created",
        "risk": "HIGH",
        "why": "A long-lived credential was created. These do not expire on their own and are "
               "the most common route for stolen access to persist.",
        "match": {"name_any": ["createaccesskey", "createlogincredential", "uploadapikey",
                               "createauthtoken", "createsecretkey", "listkeys",
                               "regeneratekey", "createorupdate/listkeys"]},
    },
    {
        "id": "credential-removed",
        "risk": "HIGH",
        "why": "A credential was deleted or deactivated. Legitimate rotation looks the same as "
               "an attacker closing a door behind them, so it is worth reading.",
        "match": {"name_any": ["deleteaccesskey", "updateaccesskey", "deleteapikey",
                               "deleteauthtoken", "deletelogincredential"]},
    },
    {
        "id": "credential-read",
        "risk": "HIGH",
        "why": "An operation that returns credential material was called — a deployment "
               "profile, an account key, a connection string or a secret value. Reading a "
               "credential is how one gets copied out, and it leaves no other trace.",
        # Added after live Azure data showed an App Service publish-profile read
        # (Microsoft.Web/sites/publishxml/action, which returns deployment
        # credentials in its response) being classified as an unremarkable
        # LOW-risk Invoke. It is a read, so no verb-based rule was ever going to
        # catch it — only naming the operations does.
        "match": {
            "name_any": [
                "listpublishingcredentials", "publishingcredentials", "publishxml",
                "listkeys", "listaccountsas", "listservicesas",
                "listconnectionstrings", "getsecretvalue", "listsecrets",
                "getparametersbypath", "getsessiontoken", "getfederationtoken",
                "exportkey", "getkey", "getauthtoken",
            ],
        },
    },
    # ── Principal lifecycle ──────────────────────────────────────────────────
    {
        "id": "principal-deleted",
        "risk": "HIGH",
        "why": "A user, group or role was deleted.",
        "match": {"name_any": ["deleteuser", "deleterole", "deletegroup",
                               "deleteserviceprincipal", "deletedynamicgroup",
                               "deleteidentityprovider"]},
    },
    {
        "id": "principal-created",
        "risk": "HIGH",
        "why": "A new principal was created — a new identity that can now act in this account.",
        "match": {"name_any": ["createuser", "createrole", "creategroup",
                               "createserviceprincipal", "createdynamicgroup",
                               "createidentityprovider", "addusertogroup",
                               "adduserstogroup"]},
    },
    # ── Denials ──────────────────────────────────────────────────────────────
    {
        "id": "denied-write",
        "risk": "HIGH",
        "why": "A change was attempted and refused. A cluster of these is what reconnaissance "
               "or a misconfigured automation looks like.",
        "match": {"status_any": ["Denied"]},
    },
    {
        "id": "failed-login",
        "risk": "HIGH",
        "why": "An authentication attempt failed.",
        "match": {"category_any": ["Authentication"], "status_any": ["Failed", "Denied"]},
    },
    # ── Destruction ──────────────────────────────────────────────────────────
    {
        "id": "resource-deleted",
        "risk": "HIGH",
        "why": "A resource was deleted.",
        "match": {"name_any": ["delete", "terminate", "destroy", "purge"]},
    },
    # ── Volume-suppression ───────────────────────────────────────────────────
    # Not a risk raise but the honest floor for machine chatter: an autoscaler
    # doing its job all day should not read as a wall of MEDIUM changes. Placed
    # last so any rule above still wins.
    {
        "id": "cloud-service-routine",
        "risk": "LOW",
        "why": "Performed by a cloud service on its own behalf (autoscaling, managed backup), "
               "not by a principal in this account.",
        "match": {"actor_type_any": ["CloudService"], "status_any": ["Success"]},
    },
]


# ── Overrides ─────────────────────────────────────────────────────────────────

_OVERRIDE_CACHE: Dict[str, Any] | None = None


def load_overrides() -> Dict[str, Any]:
    """Operator overrides from the JSON file named by EVENT_RULES_FILE.

    Shape (every key optional):

        {
          "base_risk_by_action":  {"Delete": "CRITICAL"},
          "category_risk_floor":  {"Billing": "MEDIUM"},
          "risk_rules":           [ {...same shape as RISK_RULES...} ],
          "replace_risk_rules":   false
        }

    `risk_rules` are PREPENDED to the built-ins (so an override wins on first
    match) unless `replace_risk_rules` is true. Cached after the first read;
    the file is read at import-time cost only once per process, and a change
    needs a restart — deliberate, so a half-saved file cannot silently change
    the meaning of risk mid-run.

    A malformed file is logged and ignored rather than raised: the wrong
    reaction to a typo in a tuning file is to stop collecting audit events.
    """
    global _OVERRIDE_CACHE
    if _OVERRIDE_CACHE is not None:
        return _OVERRIDE_CACHE

    path = os.getenv("EVENT_RULES_FILE", "").strip()
    overrides: Dict[str, Any] = {}
    if path:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            if isinstance(loaded, dict):
                overrides = loaded
                logger.info("Event classification overrides loaded from %s", path)
            else:
                logger.warning(
                    "EVENT_RULES_FILE %s must contain a JSON object; ignoring it.", path
                )
        except Exception as exc:
            logger.warning(
                "Could not read EVENT_RULES_FILE %s (%s) — using built-in "
                "classification rules.", path, exc,
            )

    _OVERRIDE_CACHE = overrides
    return overrides


def effective_base_risk() -> Dict[str, str]:
    merged = dict(BASE_RISK_BY_ACTION)
    merged.update(load_overrides().get("base_risk_by_action") or {})
    return merged


def effective_category_floor() -> Dict[str, str]:
    merged = dict(CATEGORY_RISK_FLOOR)
    merged.update(load_overrides().get("category_risk_floor") or {})
    return merged


def effective_risk_rules() -> List[Dict[str, Any]]:
    overrides = load_overrides()
    extra = overrides.get("risk_rules") or []
    if not isinstance(extra, list):
        logger.warning("EVENT_RULES_FILE risk_rules must be a list; ignoring it.")
        extra = []
    if overrides.get("replace_risk_rules"):
        return list(extra)
    return list(extra) + list(RISK_RULES)
