"""The three effective-permission evaluators, against the semantics they model.

No database, no network. Every case here is a place where a plausible
implementation gives a confidently wrong answer about someone's access:

* **AWS** — an explicit deny that does not win; an uncollected SCP silently
  treated as permissive; a permissions boundary ignored; `NotAction` read as
  "does not match" rather than as set negation.
* **Azure** — one role's `NotActions` subtracted from another role's `Actions`,
  which would report a principal holding both Owner and a restricted custom
  role as unable to do what Owner plainly allows; a resource-group scope
  matched by string prefix, so `prod` silently covers `production-east`;
  control-plane roles granting data-plane access.
* **OCI** — verbs treated as unordered, so `manage` does not satisfy `read`;
  an allow-only policy language reporting DENIED, which asserts an explicit
  denial the system cannot express.

The suite calls the production evaluators. It does not re-implement the
evaluation order and compare two implementations of the same idea — that is
the mistake already recorded twice in this codebase, where a test helper
re-derived the rule it was checking and passed over a live bug.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from app.identity import aws_eval, azure_eval, engine, oci_eval  # noqa: E402
from app.identity import policy_ast as ast  # noqa: E402
from app.identity.model import (  # noqa: E402
    ALLOWED, ALLOWED_UNVERIFIED, AWS, AZURE, DENIED, IMPLICIT_DENY, NOT_DETERMINED, OCI,
    PRIV_ADMIN, PRIV_PRIVILEGED, PRIV_READ_ONLY, PRIV_UNKNOWN, STAGE_DENY_ASSIGNMENT,
    STAGE_PERMISSION_BOUNDARY, STAGE_SCP,
)

ok, fail = [], []


def check(label, condition):
    (ok if condition else fail).append(label)
    print(f"  {'PASS' if condition else 'FAIL'}  {label}")


def eq(label, actual, expected):
    condition = actual == expected
    (ok if condition else fail).append(label)
    print(f"  {'PASS' if condition else 'FAIL'}  {label}")
    if not condition:
        print(f"        expected {expected!r}")
        print(f"        actual   {actual!r}")


def doc(*statements):
    return {"Version": "2012-10-17", "Statement": list(statements)}


def allow(action, resource="*", **extra):
    return {"Effect": "Allow", "Action": action, "Resource": resource, **extra}


def deny(action, resource="*", **extra):
    return {"Effect": "Deny", "Action": action, "Resource": resource, **extra}


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. AWS: explicit deny beats every allow, at every stage ===")
# ═════════════════════════════════════════════════════════════════════════════
ps = aws_eval.AwsPolicySet(
    identity_documents=[doc(allow("s3:*"), deny("s3:DeleteObject"))],
    scp_documents=[doc(allow("*"))], scp_collected=True)
eq("an allowed action is ALLOWED", aws_eval.evaluate(ps, action="s3:GetObject").decision,
   ALLOWED)
eq("an explicitly denied action is DENIED",
   aws_eval.evaluate(ps, action="s3:DeleteObject").decision, DENIED)

# Deny in the boundary, allow in the identity policy.
ps_b = aws_eval.AwsPolicySet(
    identity_documents=[doc(allow("*"))],
    boundary_document=doc(allow("*"), deny("iam:*")),
    scp_documents=[doc(allow("*"))], scp_collected=True)
eq("a deny in the permissions boundary wins over an identity allow",
   aws_eval.evaluate(ps_b, action="iam:CreateUser").decision, DENIED)

# Deny in a group policy.
ps_g = aws_eval.AwsPolicySet(
    identity_documents=[doc(allow("*"))],
    group_documents=[("Restricted", doc(deny("kms:ScheduleKeyDeletion")))],
    scp_documents=[doc(allow("*"))], scp_collected=True)
eq("a deny inherited from a group wins over a direct allow",
   aws_eval.evaluate(ps_g, action="kms:ScheduleKeyDeletion").decision, DENIED)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. AWS: an uncollected SCP makes ALLOW unverified, never certain ===")
# ═════════════════════════════════════════════════════════════════════════════
ps_no_scp = aws_eval.AwsPolicySet(identity_documents=[doc(allow("*"))])
d = aws_eval.evaluate(ps_no_scp, action="s3:GetObject")
eq("without SCPs the decision is ALLOWED_UNVERIFIED", d.decision, ALLOWED_UNVERIFIED)
check("it is not marked certain", not d.certain)
check("the skipped stage is named as the SCP stage",
      any(u.stage == STAGE_SCP for u in d.unevaluated))
check("the skipped stage names the permission that would fix it",
      any("organizations:" in (u.missing_permission or "") for u in d.unevaluated))

ps_scp = aws_eval.AwsPolicySet(identity_documents=[doc(allow("*"))],
                               scp_documents=[doc(allow("*"))], scp_collected=True)
d2 = aws_eval.evaluate(ps_scp, action="s3:GetObject")
eq("with SCPs collected the decision is ALLOWED", d2.decision, ALLOWED)
check("and it is certain", d2.certain)

# An SCP that does not permit the action blocks it regardless of the policy.
ps_scp_block = aws_eval.AwsPolicySet(
    identity_documents=[doc(allow("*"))],
    scp_documents=[doc(allow("s3:*"))], scp_collected=True)
eq("an SCP that does not allow the action blocks it",
   aws_eval.evaluate(ps_scp_block, action="ec2:RunInstances").decision, IMPLICIT_DENY)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. AWS: the permissions boundary caps the identity policy ===")
# ═════════════════════════════════════════════════════════════════════════════
ps_cap = aws_eval.AwsPolicySet(
    identity_documents=[doc(allow("*"))],
    boundary_document=doc(allow("s3:Get*")),
    scp_documents=[doc(allow("*"))], scp_collected=True)
eq("an action outside the boundary is denied",
   aws_eval.evaluate(ps_cap, action="ec2:RunInstances").decision, IMPLICIT_DENY)
eq("an action inside the boundary is allowed",
   aws_eval.evaluate(ps_cap, action="s3:GetObject").decision, ALLOWED)
check("the boundary stage appears in the trace",
      any(s.stage == STAGE_PERMISSION_BOUNDARY
          for s in aws_eval.evaluate(ps_cap, action="ec2:RunInstances").steps))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. AWS: NotAction is set negation, not 'does not match' ===")
# ═════════════════════════════════════════════════════════════════════════════
statements, err = ast.parse_document(
    doc({"Effect": "Allow", "NotAction": "iam:*", "Resource": "*"}))
eq("the document parses", err, None)
stmt = statements[0]
check("NotAction makes the statement's action set exclusionary",
      stmt.action_set_is_exclusionary)
matched, _ = ast.statement_matches_action(stmt, "s3:GetObject")
check("an action OUTSIDE the NotAction list is covered", matched)
matched2, _ = ast.statement_matches_action(stmt, "iam:CreateUser")
check("an action INSIDE the NotAction list is NOT covered", not matched2)
eq("expand_actions reports an exclusionary statement as UNBOUNDED, "
   "not as its exclusions",
   ast.expand_actions(statements), [ast.UNBOUNDED])

ps_na = aws_eval.AwsPolicySet(
    identity_documents=[doc({"Effect": "Allow", "NotAction": "iam:*",
                             "Resource": "*"})],
    scp_documents=[doc(allow("*"))], scp_collected=True)
eq("NotAction grants everything it does not exclude",
   aws_eval.evaluate(ps_na, action="ec2:RunInstances").decision, ALLOWED)
eq("NotAction denies what it excludes (implicitly)",
   aws_eval.evaluate(ps_na, action="iam:CreateUser").decision, IMPLICIT_DENY)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. AWS: resources, policy variables and unparseable documents ===")
# ═════════════════════════════════════════════════════════════════════════════
ps_res = aws_eval.AwsPolicySet(
    identity_documents=[doc(allow("s3:GetObject", "arn:aws:s3:::prod-data/*"))],
    scp_documents=[doc(allow("*"))], scp_collected=True)
eq("a matching resource is allowed",
   aws_eval.evaluate(ps_res, action="s3:GetObject",
                     resource="arn:aws:s3:::prod-data/file").decision, ALLOWED)
eq("a non-matching resource is implicitly denied",
   aws_eval.evaluate(ps_res, action="s3:GetObject",
                     resource="arn:aws:s3:::other/file").decision, IMPLICIT_DENY)

check("an unresolved policy variable refuses to match rather than guessing",
      not ast.match_token("arn:aws:s3:::${aws:username}-bucket",
                          "arn:aws:s3:::alice-bucket"))
check("has_variable recognises a policy variable",
      ast.has_variable("arn:aws:s3:::${aws:username}-bucket"))

bad, err = ast.parse_document("{not json")
eq("an unparseable document yields no statements", bad, [])
check("and reports why", bool(err))
ps_bad = aws_eval.AwsPolicySet(identity_documents=["{not json"])
eq("a principal whose only policy is unparseable is NOT_DETERMINED, not denied",
   aws_eval.evaluate(ps_bad, action="s3:GetObject").decision, NOT_DETERMINED)

# A condition makes the decision conditional rather than silently unconditional.
ps_cond = aws_eval.AwsPolicySet(
    identity_documents=[doc(allow("s3:*", "*", **{
        "Condition": {"IpAddress": {"aws:SourceIp": "10.0.0.0/8"}}}))],
    scp_documents=[doc(allow("*"))], scp_collected=True)
d_cond = aws_eval.evaluate(ps_cond, action="s3:GetObject")
check("a conditional grant is flagged conditional", d_cond.conditional)
summary = ast.condition_summary(
    {"IpAddress": {"aws:SourceIp": "10.0.0.0/8"}})
check("condition_summary detects a source-IP restriction",
      summary["restricts_source_ip"])
check("condition_summary detects an MFA requirement",
      ast.condition_summary({"Bool": {"aws:MultiFactorAuthPresent": "true"}})
      ["requires_mfa"])
check("condition_summary detects an ExternalId requirement",
      ast.condition_summary({"StringEquals": {"sts:ExternalId": "x"}})
      ["requires_external_id"])

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== F. AWS: role assumption and trust policies ===")
# ═════════════════════════════════════════════════════════════════════════════
trust = doc({
    "Effect": "Allow",
    "Principal": {"AWS": ["arn:aws:iam::999988887777:root", "123456789012"]},
    "Action": "sts:AssumeRole",
    "Condition": {"StringEquals": {"sts:ExternalId": "abc"}},
})
principals = aws_eval.trust_principals(trust)
eq("both trusted principals are extracted", len(principals), 2)
check("the ExternalId condition is recorded",
      all(p["has_external_id"] for p in principals))

trust_open = doc({"Effect": "Allow", "Principal": {"AWS": "*"},
                  "Action": "sts:AssumeRole"})
open_principals = aws_eval.trust_principals(trust_open)
eq("a wildcard principal is extracted verbatim",
   open_principals[0]["principal"], "*")
check("a wildcard trust has no ExternalId",
      not open_principals[0]["has_external_id"])

svc_trust = doc({"Effect": "Allow",
                 "Principal": {"Service": "lambda.amazonaws.com"},
                 "Action": "sts:AssumeRole"})
eq("a service principal keeps its type prefix",
   aws_eval.trust_principals(svc_trust)[0]["principal"],
   "Service:lambda.amazonaws.com")

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== G. Azure: NotActions subtract WITHIN a role, never across roles ===")
# ═════════════════════════════════════════════════════════════════════════════
owner = azure_eval.RoleAssignment(role_name="Owner", scope="/subscriptions/S",
                                  actions=["*"])
restricted = azure_eval.RoleAssignment(
    role_name="RestrictedContributor", scope="/subscriptions/S", actions=["*"],
    not_actions=["Microsoft.Authorization/*/write"])

both = azure_eval.AzureAssignmentSet(assignments=[owner, restricted],
                                     deny_assignments_collected=True)
eq("holding Owner AND a restricted role still allows what Owner allows",
   azure_eval.evaluate(both,
                       action="Microsoft.Authorization/roleAssignments/write",
                       resource="/subscriptions/S/rg").decision, ALLOWED)

only_restricted = azure_eval.AzureAssignmentSet(assignments=[restricted],
                                                deny_assignments_collected=True)
eq("the restricted role ALONE does not allow it",
   azure_eval.evaluate(only_restricted,
                       action="Microsoft.Authorization/roleAssignments/write",
                       resource="/subscriptions/S/rg").decision, IMPLICIT_DENY)
eq("the restricted role still allows what it does not exclude",
   azure_eval.evaluate(only_restricted, action="Microsoft.Compute/virtualMachines/write",
                       resource="/subscriptions/S/rg").decision, ALLOWED)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== H. Azure: scope inheritance is by path segment, not string prefix ===")
# ═════════════════════════════════════════════════════════════════════════════
check("a resource-group scope covers resources inside it",
      azure_eval.scope_covers("/subscriptions/S/resourceGroups/prod",
                              "/subscriptions/S/resourceGroups/prod/providers/X/y/z"))
check("'prod' does NOT cover 'production-east' (the prefix trap)",
      not azure_eval.scope_covers("/subscriptions/S/resourceGroups/prod",
                                  "/subscriptions/S/resourceGroups/production-east"))
check("a subscription scope covers a resource group inside it",
      azure_eval.scope_covers("/subscriptions/S",
                              "/subscriptions/S/resourceGroups/prod"))
check("one subscription does not cover another",
      not azure_eval.scope_covers("/subscriptions/A", "/subscriptions/B/resourceGroups/x"))
check("a management-group scope covers what it was collected for",
      azure_eval.scope_covers(
          "/providers/Microsoft.Management/managementGroups/root",
          "/subscriptions/S/resourceGroups/prod"))
check("an identical scope covers itself",
      azure_eval.scope_covers("/subscriptions/S/resourceGroups/prod",
                              "/subscriptions/S/resourceGroups/prod"))

rg_only = azure_eval.AzureAssignmentSet(
    assignments=[azure_eval.RoleAssignment(
        role_name="Contributor", scope="/subscriptions/S/resourceGroups/prod",
        actions=["*"])],
    deny_assignments_collected=True)
eq("a resource-group assignment does not reach another resource group",
   azure_eval.evaluate(rg_only, action="Microsoft.Compute/virtualMachines/write",
                       resource="/subscriptions/S/resourceGroups/staging/x").decision,
   IMPLICIT_DENY)
d_inherit = azure_eval.evaluate(
    rg_only, action="Microsoft.Compute/virtualMachines/write",
    resource="/subscriptions/S/resourceGroups/prod/providers/Microsoft.Compute/"
             "virtualMachines/vm1")
eq("an assignment above the resource reaches it", d_inherit.decision, ALLOWED)
check("and the step is marked inherited from the broader scope",
      any(s.inherited_from for s in d_inherit.steps))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== I. Azure: control plane and data plane do not mix ===")
# ═════════════════════════════════════════════════════════════════════════════
owner_set = azure_eval.AzureAssignmentSet(assignments=[owner],
                                          deny_assignments_collected=True)
blob_read = ("Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read")
eq("Owner does NOT grant data-plane blob read through RBAC",
   azure_eval.evaluate(owner_set, action=blob_read,
                       plane=azure_eval.PLANE_DATA).decision, IMPLICIT_DENY)
data_role = azure_eval.RoleAssignment(
    role_name="Storage Blob Data Reader", scope="/subscriptions/S",
    actions=[], data_actions=[blob_read])
data_set = azure_eval.AzureAssignmentSet(assignments=[data_role],
                                         deny_assignments_collected=True)
eq("a data role grants it on the data plane",
   azure_eval.evaluate(data_set, action=blob_read,
                       plane=azure_eval.PLANE_DATA).decision, ALLOWED)
eq("and grants nothing on the control plane",
   azure_eval.evaluate(data_set, action="Microsoft.Storage/storageAccounts/delete",
                       plane=azure_eval.PLANE_CONTROL).decision, IMPLICIT_DENY)
check("capability extraction considers BOTH planes",
      "STORAGE_READ" in azure_eval.capabilities_from_assignments(data_set))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== J. Azure: deny assignments, collected and not ===")
# ═════════════════════════════════════════════════════════════════════════════
not_collected = azure_eval.AzureAssignmentSet(assignments=[owner])
d_nc = azure_eval.evaluate(not_collected,
                           action="Microsoft.Compute/virtualMachines/write")
eq("without deny assignments the decision is ALLOWED_UNVERIFIED",
   d_nc.decision, ALLOWED_UNVERIFIED)
check("the deny-assignment stage is named",
      any(u.stage == STAGE_DENY_ASSIGNMENT for u in d_nc.unevaluated))
check("and the permission that would fix it is named",
      any("denyAssignments" in (u.missing_permission or "") for u in d_nc.unevaluated))

denied = azure_eval.AzureAssignmentSet(
    assignments=[owner], deny_assignments_collected=True,
    deny_assignments=[azure_eval.DenyAssignment(
        name="LockedByBlueprint", scope="/subscriptions/S",
        actions=["Microsoft.Compute/virtualMachines/delete"])])
eq("a deny assignment beats Owner",
   azure_eval.evaluate(denied, action="Microsoft.Compute/virtualMachines/delete",
                       resource="/subscriptions/S/rg").decision, DENIED)
excluded = azure_eval.AzureAssignmentSet(
    assignments=[owner], deny_assignments_collected=True,
    deny_assignments=[azure_eval.DenyAssignment(
        name="LockedByBlueprint", scope="/subscriptions/S",
        actions=["Microsoft.Compute/virtualMachines/delete"],
        excluded_principals=["principal-1"])])
eq("a deny assignment that EXCLUDES this principal does not block it",
   azure_eval.evaluate(excluded, action="Microsoft.Compute/virtualMachines/delete",
                       resource="/subscriptions/S/rg",
                       principal_id="principal-1").decision, ALLOWED)

uncollected_assignments = azure_eval.AzureAssignmentSet(assignments_collected=False)
eq("when role assignments were refused the answer is NOT_DETERMINED, not denied",
   azure_eval.evaluate(uncollected_assignments,
                       action="Microsoft.Compute/virtualMachines/write").decision,
   NOT_DETERMINED)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== K. OCI: ranked verbs, allow-only, and the policy grammar ===")
# ═════════════════════════════════════════════════════════════════════════════
stmt = oci_eval.parse_statement(
    "Allow group Admins to manage all-resources in tenancy", policy_name="P")
check("the statement parses", stmt.parsed)
eq("the verb is read", stmt.verb, "manage")
eq("the resource family is read", stmt.resource_type, "all-resources")
eq("the subject kind is read", stmt.subject_kind, "group")
eq("the subject name is read", stmt.subject_names, ["Admins"])
eq("the location is the tenancy", stmt.location_kind, "tenancy")

admins = oci_eval.OciPolicySet(statements=[stmt], subject_names=["Admins"],
                               subject_kind="group")
eq("manage all-resources satisfies a read question",
   oci_eval.evaluate(admins, action="read:object-family").decision, ALLOWED)
eq("and a manage question", oci_eval.evaluate(admins,
                                              action="manage:database-family").decision,
   ALLOWED)

readers = oci_eval.OciPolicySet(
    statements=[oci_eval.parse_statement(
        "Allow group Readers to read object-family in tenancy")],
    subject_names=["Readers"], subject_kind="group")
eq("read does NOT satisfy a manage question",
   oci_eval.evaluate(readers, action="manage:object-family").decision, IMPLICIT_DENY)
check("OCI never returns DENIED — the language has no explicit deny",
      oci_eval.evaluate(readers, action="manage:object-family").decision != DENIED)

# A principal the statement does not name gets nothing.
others = oci_eval.OciPolicySet(statements=[stmt], subject_names=["Developers"],
                               subject_kind="group")
eq("a statement naming another group does not apply",
   oci_eval.evaluate(others, action="read:object-family").decision, IMPLICIT_DENY)

# any-user applies to everyone, and is flagged.
any_stmt = oci_eval.parse_statement(
    "Allow any-user to read object-family in tenancy "
    "where request.principal.type = 'instance'")
check("any-user is recognised", any_stmt.to_dict()["any_user"])
check("the where-clause is preserved", bool(any_stmt.condition))
any_set = oci_eval.OciPolicySet(statements=[any_stmt], subject_names=["Anyone"],
                                subject_kind="group")
d_any = oci_eval.evaluate(any_set, action="read:object-family")
eq("any-user applies to a principal it does not name", d_any.decision, ALLOWED)
check("and the decision is marked conditional because of the where-clause",
      d_any.conditional)

# Cross-tenancy keywords are parsed but are NOT in-tenancy grants.
endorse = oci_eval.parse_statement(
    "Endorse group Admins to manage object-family in tenancy ocid1.tenancy.oc1..aaa")
check("an endorse statement is not treated as an in-tenancy grant",
      not endorse.parsed)
check("and says why", "endorse" in (endorse.parse_error or ""))

# A malformed statement is carried, not dropped.
broken = oci_eval.parse_statement("Allow group Admins manage everything")
check("a malformed statement reports a parse error", broken.parse_error is not None)
broken_set = oci_eval.OciPolicySet(statements=[broken], subject_names=["Admins"],
                                   subject_kind="group")
d_broken = oci_eval.evaluate(broken_set, action="read:object-family")
check("an unparseable statement makes the result uncertain rather than silent",
      not d_broken.certain or d_broken.decision == IMPLICIT_DENY)

uncollected = oci_eval.OciPolicySet(policies_collected=False)
eq("when policies were not collected the answer is NOT_DETERMINED",
   oci_eval.evaluate(uncollected, action="read:object-family").decision, NOT_DETERMINED)
eq("a non-OCI action shape is NOT_DETERMINED rather than guessed",
   oci_eval.evaluate(admins, action="s3:GetObject").decision, NOT_DETERMINED)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== L. The dispatcher and the privilege classifier ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("an unknown provider is NOT_DETERMINED, never evaluated by another engine",
   engine.evaluate("GCP", None, action="storage.objects.get").decision, NOT_DETERMINED)

eq("a wildcard grant is ADMIN", engine.classify_privilege(AWS, ["*"]), PRIV_ADMIN)
eq("IAM write is ADMIN even without a wildcard",
   engine.classify_privilege(AWS, ["iam:PutRolePolicy"]), PRIV_ADMIN)
eq("a high-impact capability without IAM is PRIVILEGED",
   engine.classify_privilege(AWS, ["s3:DeleteObject"]), PRIV_PRIVILEGED)
eq("Azure Reader is READ_ONLY, not privileged",
   engine.classify_privilege(AZURE, ["*/read"]), PRIV_READ_ONLY)
eq("an unevaluable principal is UNKNOWN, never READ_ONLY",
   engine.classify_privilege(AWS, [], evaluable=False), PRIV_UNKNOWN)
eq("a principal with genuinely no grants is READ_ONLY",
   engine.classify_privilege(AWS, []), PRIV_READ_ONLY)

standing, reason = engine.is_standing_admin(AZURE, ["*"], scope_level="subscription")
check("subscription-wide wildcard is standing admin", standing)
check("and it says why", bool(reason))
narrow, _ = engine.is_standing_admin(AZURE, ["*"], scope_level="resource")
check("the same grant on one resource is not standing admin", not narrow)
unevaluable, _ = engine.is_standing_admin(AZURE, [], evaluable=False)
check("an unevaluable principal is never reported as standing admin", not unevaluable)

# summarize() must produce one coherent picture in one pass.
summary = engine.summarize(AZURE, both)
eq("summarize reports ADMIN for an Owner assignment",
   summary["privilege_level"], PRIV_ADMIN)
check("summarize carries the evidence for each capability",
      all(isinstance(v, list) and v for v in summary["capabilities"].values()))
check("summarize reports full control for a wildcard", summary["full_control"])
unevaluated_summary = engine.summarize(AWS, ps, evaluable=False)
eq("an unevaluable summary is UNKNOWN", unevaluated_summary["privilege_level"],
   PRIV_UNKNOWN)
eq("and claims no capabilities", unevaluated_summary["capabilities"], {})

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
