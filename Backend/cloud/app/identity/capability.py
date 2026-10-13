"""What a granted action actually lets someone do, in one vocabulary.

Two questions, and they are not the same question:

1.  **Classify** — given a CONCRETE action the provider recorded in an audit
    event (`s3:DeleteObject`), which normalized capability is it? Used by the
    usage correlator, where the input is always concrete.

2.  **Cover** — given a GRANTED action pattern, which may be a wildcard
    (`s3:*`, `*/read`, `manage all-resources`), which capabilities does it
    confer? Used by the privilege classifier and the blast-radius engine.

Question 2 is where the direction of the glob match decides whether the answer
is right, and `security/identity.py` records what happens when it is backwards:
`fnmatch(action, "*")` asks "does the string `*/read` match the pattern `*`",
which is true of every string, and the built-in **Reader** role was reported as
full subscription control on 23 live assignments.

The correct question is the other way round — "does this granted pattern COVER
this concrete privileged operation?" — so the GRANT is the pattern and a
concrete probe operation is the string:

    fnmatch("iam:PutRolePolicy", granted_action)

Under that test `*/read` covers nothing privileged, `s3:*` covers the storage
probes and nothing else, and a custom role carrying
`Microsoft.Authorization/*` is caught without anyone having to recognise it by
name. Every capability below is therefore defined by a list of concrete
operations that are representative of it, and coverage is decided by matching
the grant against those operations. Adding a capability means adding probes,
never adding a name to a list of known-bad role names.

**OCI is not an action string.** Its policy language is `<verb> <resource-
family>`, with four ranked verbs (inspect < read < use < manage), so its
probes are `verb:family` pairs and matching is rank-aware rather than glob.
Pretending OCI actions look like AWS ones is how `manage all-resources` ends up
classified as OTHER.
"""
from __future__ import annotations

import fnmatch
from typing import Dict, FrozenSet, Iterable, List, Optional, Sequence, Set, Tuple

from app.identity.model import (
    AWS, AZURE, CAP_BACKUP_DELETE, CAP_COMPUTE_ADMINISTRATION,
    CAP_CREDENTIAL_CREATION, CAP_DATABASE_ADMINISTRATION, CAP_DATABASE_READ,
    CAP_DATABASE_WRITE, CAP_IAM_ADMINISTRATION, CAP_IDENTITY_ADMINISTRATION,
    CAP_KEY_MANAGEMENT, CAP_LOGGING_CONFIGURATION, CAP_NETWORK_ADMINISTRATION,
    CAP_OTHER, CAP_RESOURCE_DELETE, CAP_ROLE_ASSUMPTION,
    CAP_SECURITY_CONFIGURATION, CAP_STORAGE_DELETE, CAP_STORAGE_READ,
    CAP_STORAGE_WRITE, HIGH_IMPACT_CAPABILITIES, OCI, normalize_provider,
)

# ── AWS probes ───────────────────────────────────────────────────────────────
# Concrete operations, deliberately several per capability and drawn from
# different services where that matters: a grant scoped to one service's writes
# is broad within that service but is not account-wide write, and one probe
# would not tell them apart.
AWS_PROBES: Dict[str, Tuple[str, ...]] = {
    CAP_IAM_ADMINISTRATION: (
        "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutUserPolicy",
        "iam:AttachUserPolicy", "iam:CreatePolicyVersion",
        "iam:UpdateAssumeRolePolicy", "iam:AttachGroupPolicy",
        "iam:PutRolePermissionsBoundary",
    ),
    CAP_IDENTITY_ADMINISTRATION: (
        "iam:CreateUser", "iam:DeleteUser", "iam:CreateRole", "iam:DeleteRole",
        "iam:CreateGroup", "iam:AddUserToGroup", "sso:CreateAccountAssignment",
    ),
    CAP_CREDENTIAL_CREATION: (
        "iam:CreateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile",
        "iam:CreateServiceSpecificCredential", "iam:UploadSSHPublicKey",
        "iam:DeactivateMFADevice",
    ),
    CAP_ROLE_ASSUMPTION: (
        "sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity",
        "iam:PassRole",
    ),
    CAP_NETWORK_ADMINISTRATION: (
        "ec2:AuthorizeSecurityGroupIngress", "ec2:CreateRoute",
        "ec2:CreateInternetGateway", "ec2:ModifyVpcEndpoint",
        "ec2:CreateNetworkAclEntry", "elasticloadbalancing:SetSecurityGroups",
    ),
    CAP_COMPUTE_ADMINISTRATION: (
        "ec2:RunInstances", "ec2:ModifyInstanceAttribute", "ecs:RunTask",
        "lambda:UpdateFunctionCode", "ssm:SendCommand",
    ),
    CAP_STORAGE_READ: ("s3:GetObject", "s3:ListBucket", "s3:GetBucketPolicy"),
    CAP_STORAGE_WRITE: ("s3:PutObject", "s3:PutBucketPolicy", "s3:PutObjectAcl"),
    CAP_STORAGE_DELETE: ("s3:DeleteObject", "s3:DeleteBucket", "s3:DeleteObjectVersion"),
    CAP_DATABASE_READ: (
        "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan",
        "rds:DownloadDBLogFilePortion", "redshift-data:GetStatementResult",
    ),
    CAP_DATABASE_WRITE: ("dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"),
    CAP_DATABASE_ADMINISTRATION: (
        "rds:DeleteDBInstance", "rds:ModifyDBInstance", "rds:CreateDBInstance",
        "dynamodb:DeleteTable", "rds:ModifyDBClusterParameterGroup",
        "redshift:DeleteCluster",
    ),
    CAP_SECURITY_CONFIGURATION: (
        "guardduty:DeleteDetector", "guardduty:UpdateDetector",
        "securityhub:DisableSecurityHub", "config:DeleteConfigRule",
        "inspector2:Disable", "macie2:DisableMacie",
        "ec2:ModifySnapshotAttribute", "accessanalyzer:DeleteAnalyzer",
    ),
    CAP_LOGGING_CONFIGURATION: (
        "cloudtrail:StopLogging", "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail", "logs:DeleteLogGroup",
        "config:StopConfigurationRecorder", "logs:PutRetentionPolicy",
    ),
    CAP_KEY_MANAGEMENT: (
        "kms:ScheduleKeyDeletion", "kms:PutKeyPolicy", "kms:CreateGrant",
        "kms:Decrypt", "kms:DisableKey", "secretsmanager:GetSecretValue",
        "secretsmanager:DeleteSecret",
    ),
    CAP_BACKUP_DELETE: (
        "backup:DeleteRecoveryPoint", "backup:DeleteBackupVault",
        "rds:DeleteDBSnapshot", "ec2:DeleteSnapshot",
        "backup:DeleteBackupPlan", "dynamodb:DeleteBackup",
    ),
    CAP_RESOURCE_DELETE: (
        "ec2:TerminateInstances", "s3:DeleteBucket", "rds:DeleteDBInstance",
        "lambda:DeleteFunction", "cloudformation:DeleteStack",
        "eks:DeleteCluster", "ecs:DeleteCluster",
    ),
}

# ── Azure probes ─────────────────────────────────────────────────────────────
# Operation strings as they appear in a role definition's Actions/DataActions.
# The Actions / DataActions split matters and is handled by the caller: a role
# with `Microsoft.Storage/storageAccounts/*` in Actions can read the account's
# KEYS (and so its data) but has no DataActions, which is why listKeys is a
# STORAGE_READ probe in its own right.
AZURE_PROBES: Dict[str, Tuple[str, ...]] = {
    CAP_IAM_ADMINISTRATION: (
        "Microsoft.Authorization/roleAssignments/write",
        "Microsoft.Authorization/roleDefinitions/write",
        "Microsoft.Authorization/elevateAccess/action",
        "Microsoft.Authorization/denyAssignments/write",
    ),
    CAP_IDENTITY_ADMINISTRATION: (
        "Microsoft.ManagedIdentity/userAssignedIdentities/write",
        "Microsoft.ManagedIdentity/userAssignedIdentities/delete",
        "Microsoft.AAD/domainServices/write",
    ),
    CAP_CREDENTIAL_CREATION: (
        "Microsoft.Storage/storageAccounts/regenerateKey/action",
        "Microsoft.Web/sites/config/list/action",
        "Microsoft.ContainerRegistry/registries/listCredentials/action",
        "Microsoft.DocumentDB/databaseAccounts/regenerateKey/action",
    ),
    CAP_ROLE_ASSUMPTION: (
        "Microsoft.ManagedIdentity/userAssignedIdentities/assign/action",
    ),
    CAP_NETWORK_ADMINISTRATION: (
        "Microsoft.Network/networkSecurityGroups/write",
        "Microsoft.Network/networkSecurityGroups/securityRules/write",
        "Microsoft.Network/routeTables/write",
        "Microsoft.Network/publicIPAddresses/write",
        "Microsoft.Network/virtualNetworks/subnets/write",
        "Microsoft.Network/azureFirewalls/write",
    ),
    CAP_COMPUTE_ADMINISTRATION: (
        "Microsoft.Compute/virtualMachines/write",
        "Microsoft.Compute/virtualMachines/runCommand/action",
        "Microsoft.Compute/virtualMachines/extensions/write",
        "Microsoft.ContainerService/managedClusters/write",
    ),
    CAP_STORAGE_READ: (
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
        "Microsoft.Storage/storageAccounts/listKeys/action",
        "Microsoft.Storage/storageAccounts/blobServices/containers/read",
    ),
    CAP_STORAGE_WRITE: (
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
        "Microsoft.Storage/storageAccounts/blobServices/containers/write",
    ),
    CAP_STORAGE_DELETE: (
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
        "Microsoft.Storage/storageAccounts/delete",
        "Microsoft.Storage/storageAccounts/blobServices/containers/delete",
    ),
    CAP_DATABASE_READ: (
        "Microsoft.Sql/servers/databases/read",
        "Microsoft.DocumentDB/databaseAccounts/readonlykeys/action",
    ),
    CAP_DATABASE_WRITE: (
        "Microsoft.Sql/servers/databases/write",
        "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/write",
    ),
    CAP_DATABASE_ADMINISTRATION: (
        "Microsoft.Sql/servers/databases/delete",
        "Microsoft.Sql/servers/write",
        "Microsoft.Sql/servers/firewallRules/write",
        "Microsoft.DBforPostgreSQL/servers/delete",
    ),
    CAP_SECURITY_CONFIGURATION: (
        "Microsoft.Security/pricings/write",
        "Microsoft.Security/policies/write",
        "Microsoft.Security/autoProvisioningSettings/write",
        "Microsoft.Security/alerts/dismiss/action",
    ),
    CAP_LOGGING_CONFIGURATION: (
        "Microsoft.Insights/diagnosticSettings/delete",
        "Microsoft.Insights/diagnosticSettings/write",
        "Microsoft.Insights/logProfiles/delete",
        "Microsoft.OperationalInsights/workspaces/delete",
    ),
    CAP_KEY_MANAGEMENT: (
        "Microsoft.KeyVault/vaults/write",
        "Microsoft.KeyVault/vaults/delete",
        "Microsoft.KeyVault/vaults/secrets/getSecret/action",
        "Microsoft.KeyVault/vaults/keys/delete/action",
        "Microsoft.KeyVault/vaults/accessPolicies/write",
    ),
    CAP_BACKUP_DELETE: (
        "Microsoft.RecoveryServices/vaults/delete",
        "Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers/"
        "protectedItems/delete",
        "Microsoft.Compute/snapshots/delete",
    ),
    CAP_RESOURCE_DELETE: (
        "Microsoft.Resources/subscriptions/resourceGroups/delete",
        "Microsoft.Compute/virtualMachines/delete",
        "Microsoft.Sql/servers/delete",
        "Microsoft.Web/sites/delete",
    ),
}

# ── OCI probes ───────────────────────────────────────────────────────────────
# `verb:resource-family`. The verbs are ranked, so a grant of `manage` covers a
# `read` probe on the same family; `all-resources` is the family wildcard.
OCI_VERBS: Tuple[str, ...] = ("inspect", "read", "use", "manage")
OCI_VERB_RANK: Dict[str, int] = {v: i for i, v in enumerate(OCI_VERBS)}
OCI_ALL_RESOURCES = "all-resources"

OCI_PROBES: Dict[str, Tuple[str, ...]] = {
    CAP_IAM_ADMINISTRATION: ("manage:policies",),
    CAP_IDENTITY_ADMINISTRATION: (
        "manage:users", "manage:groups", "manage:dynamic-groups",
        "manage:compartments", "manage:identity-providers",
    ),
    CAP_CREDENTIAL_CREATION: ("manage:users",),
    CAP_ROLE_ASSUMPTION: ("manage:dynamic-groups",),
    CAP_NETWORK_ADMINISTRATION: (
        "manage:virtual-network-family", "use:virtual-network-family",
        "manage:load-balancers",
    ),
    CAP_COMPUTE_ADMINISTRATION: (
        "manage:instance-family", "use:instance-family", "manage:cluster-family",
    ),
    CAP_STORAGE_READ: ("read:object-family", "inspect:object-family", "read:buckets"),
    CAP_STORAGE_WRITE: ("manage:object-family", "use:object-family"),
    CAP_STORAGE_DELETE: ("manage:object-family", "manage:buckets"),
    CAP_DATABASE_READ: ("read:database-family", "inspect:database-family"),
    CAP_DATABASE_WRITE: ("use:database-family",),
    CAP_DATABASE_ADMINISTRATION: (
        "manage:database-family", "manage:autonomous-database-family",
    ),
    CAP_SECURITY_CONFIGURATION: (
        "manage:cloudguard-config", "manage:security-zone", "manage:vss-family",
    ),
    CAP_LOGGING_CONFIGURATION: (
        "manage:log-groups", "manage:log-content", "manage:audit-events",
    ),
    CAP_KEY_MANAGEMENT: (
        "manage:vaults", "manage:keys", "use:keys", "read:secret-family",
        "manage:secret-family",
    ),
    CAP_BACKUP_DELETE: (
        "manage:volume-family", "manage:backups", "manage:db-backups",
    ),
    CAP_RESOURCE_DELETE: (
        "manage:instance-family", "manage:volume-family", "manage:database-family",
        "manage:object-family", "manage:file-family",
    ),
}

PROBES_BY_PROVIDER: Dict[str, Dict[str, Tuple[str, ...]]] = {
    AWS: AWS_PROBES, AZURE: AZURE_PROBES, OCI: OCI_PROBES,
}

# Grants that confer everything. Matched exactly, never by glob: a role that
# happens to cover every probe we test is still not the same statement as `*`,
# and conflating them would make a broad-but-bounded role indistinguishable
# from Owner — the Contributor/Owner distinction `security/identity.py` keeps.
FULL_CONTROL_GRANTS: Dict[str, FrozenSet[str]] = {
    AWS: frozenset({"*"}),
    AZURE: frozenset({"*"}),
    OCI: frozenset({"manage:all-resources"}),
}


def _norm(provider: Optional[str]) -> Optional[str]:
    return normalize_provider(provider)


# ── Question 1: classify a concrete action ───────────────────────────────────
def classify_action(provider: str, action: Optional[str]) -> str:
    """The capability a CONCRETE action belongs to.

    Input must be an action the provider actually performed or a probe — not a
    wildcard grant. A wildcard reaching here returns CAP_OTHER rather than
    silently claiming one capability, because `s3:*` is not "storage read"; it
    is storage read AND write AND delete, which is `capabilities_covered`'s
    question, not this one.
    """
    prov = _norm(provider)
    if not prov or not action:
        return CAP_OTHER
    probes = PROBES_BY_PROVIDER.get(prov) or {}
    needle = action.strip()
    if not needle or "*" in needle:
        return CAP_OTHER

    if prov == OCI:
        needle = _oci_canonical(needle) or needle

    # Exact membership first — unambiguous and cheap.
    for capability, ops in probes.items():
        if needle in ops:
            return capability

    # Then a heuristic on shape, which is how an action NOT in the probe list
    # (the long tail — there are ~18,000 AWS actions) still lands somewhere
    # useful instead of all becoming OTHER.
    return _heuristic(prov, needle)


def _heuristic(provider: str, action: str) -> str:
    """Shape-based fallback for actions outside the probe catalog.

    Deliberately conservative: it only recognises the service/namespace and
    the verb, and returns CAP_OTHER when either is unclear. A wrong confident
    answer here would mislabel evidence shown to an operator.
    """
    lowered = action.lower()
    if provider == AWS:
        service, _, op = lowered.partition(":")
        if not op:
            return CAP_OTHER
        if service in ("iam", "sso", "identitystore", "organizations"):
            return (CAP_IAM_ADMINISTRATION
                    if any(op.startswith(v) for v in ("put", "attach", "update", "create",
                                                      "delete", "detach", "remove"))
                    else CAP_OTHER)
        if service == "sts":
            return CAP_ROLE_ASSUMPTION
        if service == "kms" or service == "secretsmanager":
            return CAP_KEY_MANAGEMENT
        if service in ("cloudtrail", "logs", "config"):
            return CAP_LOGGING_CONFIGURATION
        if service in ("guardduty", "securityhub", "inspector2", "macie2", "accessanalyzer"):
            return CAP_SECURITY_CONFIGURATION
        if service == "backup":
            return CAP_BACKUP_DELETE if op.startswith("delete") else CAP_OTHER
        if service == "s3":
            if op.startswith("delete"):
                return CAP_STORAGE_DELETE
            if op.startswith(("put", "create", "restore", "write")):
                return CAP_STORAGE_WRITE
            if op.startswith(("get", "list", "head", "describe")):
                return CAP_STORAGE_READ
            return CAP_OTHER
        if service in ("rds", "dynamodb", "redshift", "docdb", "neptune", "elasticache"):
            if op.startswith(("delete", "modify", "create", "restore")):
                return CAP_DATABASE_ADMINISTRATION
            if op.startswith(("put", "update", "batchwrite")):
                return CAP_DATABASE_WRITE
            if op.startswith(("get", "query", "scan", "batchget")):
                return CAP_DATABASE_READ
            return CAP_OTHER
        if service == "ec2":
            # EC2 is two services wearing one prefix: the compute API and the
            # VPC API. Classifying on the verb alone gets the VPC half wrong —
            # `DeleteNetworkAclEntry` is a network change, not a resource
            # deletion — so the NOUN decides first and the verb only afterwards.
            if any(noun in op for noun in (
                "securitygroup", "networkacl", "route", "internetgateway",
                "natgateway", "vpcendpoint", "vpcpeering", "subnet", "vpc",
                "networkinterface", "transitgateway", "egressonly",
                "customergateway", "vpngateway", "vpnconnection", "prefixlist",
            )):
                if op.startswith(("describe", "get", "list", "search")):
                    return CAP_OTHER
                return CAP_NETWORK_ADMINISTRATION
            if op.startswith("terminate"):
                return CAP_RESOURCE_DELETE
            if op.startswith(("run", "start", "stop", "modify", "reboot", "create")):
                return CAP_COMPUTE_ADMINISTRATION
            return CAP_OTHER
        if op.startswith("delete"):
            return CAP_RESOURCE_DELETE
        return CAP_OTHER

    if provider == AZURE:
        if lowered.startswith("microsoft.authorization/"):
            return (CAP_IAM_ADMINISTRATION
                    if lowered.endswith(("/write", "/delete", "/action"))
                    else CAP_OTHER)
        if lowered.startswith("microsoft.network/"):
            return CAP_NETWORK_ADMINISTRATION if lowered.endswith(("/write", "/delete")) \
                else CAP_OTHER
        if lowered.startswith("microsoft.keyvault/"):
            return CAP_KEY_MANAGEMENT
        if lowered.startswith("microsoft.security/"):
            return CAP_SECURITY_CONFIGURATION
        if lowered.startswith(("microsoft.insights/", "microsoft.operationalinsights/")):
            return CAP_LOGGING_CONFIGURATION
        if lowered.startswith("microsoft.storage/"):
            if lowered.endswith("/delete"):
                return CAP_STORAGE_DELETE
            if lowered.endswith("/write"):
                return CAP_STORAGE_WRITE
            if lowered.endswith(("/read", "/action")):
                return CAP_STORAGE_READ
            return CAP_OTHER
        if lowered.startswith(("microsoft.sql/", "microsoft.dbfor", "microsoft.documentdb/")):
            if lowered.endswith("/delete"):
                return CAP_DATABASE_ADMINISTRATION
            if lowered.endswith("/write"):
                return CAP_DATABASE_WRITE
            if lowered.endswith("/read"):
                return CAP_DATABASE_READ
            return CAP_OTHER
        if lowered.startswith(("microsoft.compute/", "microsoft.containerservice/")):
            return CAP_RESOURCE_DELETE if lowered.endswith("/delete") \
                else CAP_COMPUTE_ADMINISTRATION if lowered.endswith(("/write", "/action")) \
                else CAP_OTHER
        if lowered.endswith("/delete"):
            return CAP_RESOURCE_DELETE
        return CAP_OTHER

    if provider == OCI:
        verb, _, family = lowered.partition(":")
        if verb not in OCI_VERB_RANK:
            return CAP_OTHER
        if family in ("policies",):
            return CAP_IAM_ADMINISTRATION
        if family in ("users", "groups", "dynamic-groups", "compartments",
                      "identity-providers"):
            return CAP_IDENTITY_ADMINISTRATION
        if "virtual-network" in family or family == "load-balancers":
            return CAP_NETWORK_ADMINISTRATION
        if "instance" in family or "cluster" in family:
            return CAP_COMPUTE_ADMINISTRATION
        if "object" in family or family == "buckets":
            if verb == "manage":
                return CAP_STORAGE_DELETE
            if verb == "use":
                return CAP_STORAGE_WRITE
            return CAP_STORAGE_READ
        if "database" in family:
            return CAP_DATABASE_ADMINISTRATION if verb == "manage" else CAP_DATABASE_READ
        if family in ("vaults", "keys") or "secret" in family:
            return CAP_KEY_MANAGEMENT
        if "log" in family or "audit" in family:
            return CAP_LOGGING_CONFIGURATION
        if "cloudguard" in family or "security" in family or "vss" in family:
            return CAP_SECURITY_CONFIGURATION
        return CAP_OTHER

    return CAP_OTHER


def _oci_canonical(token: str) -> Optional[str]:
    """Normalize an OCI grant to `verb:family`.

    Accepts both the colon form this module uses internally and the policy
    language's own `manage object-family`, because statements are parsed
    straight out of the tenancy and should not need pre-formatting.
    """
    raw = token.strip().lower()
    if ":" in raw:
        verb, _, family = raw.partition(":")
    else:
        parts = raw.split()
        if len(parts) < 2:
            return None
        verb, family = parts[0], parts[1]
    verb, family = verb.strip(), family.strip()
    if verb not in OCI_VERB_RANK:
        return None
    return f"{verb}:{family}"


# ── Question 2: what a grant covers ──────────────────────────────────────────
def covers(provider: str, granted: str, operation: str) -> bool:
    """Does this GRANTED pattern cover this concrete OPERATION?

    The grant is the pattern and the operation is the string. Getting this
    backwards is the Reader-reported-as-Owner bug; the argument order of this
    function is the guard against repeating it, and the test suite pins it.
    """
    prov = _norm(provider)
    if not prov or not granted or not operation:
        return False
    grant = granted.strip()

    if prov == OCI:
        g = _oci_canonical(grant)
        o = _oci_canonical(operation)
        if not g or not o:
            return False
        gv, _, gf = g.partition(":")
        ov, _, of = o.partition(":")
        # A higher verb covers a lower one (manage covers read), and
        # all-resources covers every family.
        if OCI_VERB_RANK[gv] < OCI_VERB_RANK[ov]:
            return False
        if gf == OCI_ALL_RESOURCES:
            return True
        return fnmatch.fnmatchcase(of, gf)

    # AWS and Azure: case-insensitive glob, grant as the pattern.
    return fnmatch.fnmatchcase(operation.lower(), grant.lower())


def capabilities_covered(provider: str, granted_actions: Iterable[str]) -> Set[str]:
    """Every capability the given grants confer, by probe coverage."""
    prov = _norm(provider)
    if not prov:
        return set()
    probes = PROBES_BY_PROVIDER.get(prov) or {}
    grants = [g for g in (granted_actions or []) if g]
    out: Set[str] = set()
    for capability, operations in probes.items():
        for op in operations:
            if any(covers(prov, g, op) for g in grants):
                out.add(capability)
                break
    return out


def high_impact_covered(provider: str, granted_actions: Iterable[str]) -> List[str]:
    """The §25 dangerous capabilities present, in catalog order."""
    held = capabilities_covered(provider, granted_actions)
    return [c for c in HIGH_IMPACT_CAPABILITIES if c in held]


def is_full_control(provider: str, granted_actions: Iterable[str]) -> bool:
    """Whether a grant is the literal everything wildcard.

    Exact match only. A role covering every probe is broad, and is reported as
    broad; it is not the same claim as holding `*`.
    """
    prov = _norm(provider)
    if not prov:
        return False
    full = FULL_CONTROL_GRANTS.get(prov, frozenset())
    for g in granted_actions or []:
        token = (g or "").strip()
        if prov == OCI:
            token = _oci_canonical(token) or token
        if token in full:
            return True
    return False


def probe_operations(provider: str, capability: str) -> Tuple[str, ...]:
    """The concrete operations that stand for a capability — the evidence a
    finding quotes when it says an identity holds one."""
    prov = _norm(provider)
    return (PROBES_BY_PROVIDER.get(prov or "", {}) or {}).get(capability, ())


def all_probe_operations(provider: str) -> Tuple[str, ...]:
    """Every probe for a provider, de-duplicated and stable in order."""
    prov = _norm(provider)
    seen: List[str] = []
    for ops in (PROBES_BY_PROVIDER.get(prov or "", {}) or {}).values():
        for op in ops:
            if op not in seen:
                seen.append(op)
    return tuple(seen)


def catalog(provider: Optional[str] = None) -> Dict[str, object]:
    """The capability catalog, for the UI legend and for verification."""
    provs: Sequence[str] = (
        [p for p in (_norm(provider),) if p] if provider else list(PROBES_BY_PROVIDER)
    )
    return {
        "providers": {
            p: {
                cap: {
                    "label": cap,
                    "high_impact": cap in HIGH_IMPACT_CAPABILITIES,
                    "probe_operations": list(ops),
                }
                for cap, ops in (PROBES_BY_PROVIDER.get(p) or {}).items()
            }
            for p in provs
        },
        "oci_verb_order": list(OCI_VERBS),
        "full_control_grants": {k: sorted(v) for k, v in FULL_CONTROL_GRANTS.items()},
    }
