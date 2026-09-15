"""The classification engine: operation string in, (category, action, risk) out.

Deliberately tiny. All the judgement lives in app/events/rules.py as data, so
this module is only the walk: derive mechanically, apply the floor, then let
the first matching specific rule raise the level and record why.

Two invariants worth stating because they are easy to break later:

*   **Rules can only raise risk, never lower it** — except for the one rule
    explicitly marked `allow_lower`, which exists for cloud-service chatter.
    Without that asymmetry a broadly-written tuning rule can quietly demote a
    destructive call off the first page of an investigation.

*   **Nothing here guesses at a provider field.** Classification reads the
    operation name, the derived category, the actor type, the status and the
    request parameters — all of which the provider supplied. It never invents
    a source IP, a country, or a previous state.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

from app.events.rules import (
    ACTION_PATTERNS,
    AZURE_VERB_SUFFIX,
    CATEGORY_PATTERNS,
    OCI_REQUEST_ACTION,
    effective_base_risk,
    effective_category_floor,
    effective_risk_rules,
)
from app.models.cloud_event import RISK_ORDER

# How much of a request-parameters blob is searched for payload markers. A
# CloudTrail requestParameters for a bulk API can be hundreds of KB; the
# markers we look for ("0.0.0.0/0", "AdministratorAccess") appear in the
# meaningful part, and scanning megabytes per event for every rule is the kind
# of cost that turns ingestion into the bottleneck.
_PAYLOAD_SCAN_LIMIT = 20_000


def _word_starts_at(original: str, index: int) -> bool:
    """Does a word begin at `index` in `original` (case preserved)?

    Three ways to begin a word, and the third is the one that matters:

    1.  the very start of the string;
    2.  straight after a non-letter — a dot, slash, space, digit or dash;
    3.  at a capital that follows a lowercase letter — a CamelCase hump.

    Case 3 is why the ORIGINAL casing has to be kept rather than lowercasing
    first: provider operation names are CamelCase, and "SecurityGroup" inside
    "AuthorizeSecurityGroupIngress" is a real word start that a lowercased
    string cannot show.

    A capital following another capital is deliberately NOT a word start. An
    all-caps run carries no case information — Azure returns resource ids fully
    upper-cased — and treating every letter in "/SUBSCRIPTIONS/" as a word
    start is what let "ons" match inside it.
    """
    if index == 0:
        return True
    previous = original[index - 1]
    if not previous.isalpha():
        return True
    current = original[index]
    return current.isupper() and not previous.isupper()


def matches_fragment(haystack_lower: str, fragment: str, original: str = None) -> bool:
    """Does `fragment` occur in the haystack at a word boundary?

    A plain `in` test is what this replaces, and it was wrong in ways only live
    data exposed. Real examples, every one from a single Azure subscription:

        "ebs"    matched inside  st(opWEBS)ite         -> a web app read as Storage
        "ons"    matched inside  subscripti(ONS)       -> everything read as Monitoring
        "group"  matched inside  networkSecurity(Group)s -> firewalls read as IAM

    while these are legitimate and must still match:

        "securitygroup"  inside  Authorize(SecurityGroup)Ingress
        "bucket"         inside  (bucket)s
        "create"         inside  (create)vcn

    So the test is a word START, not a whole word: a fragment may be followed
    by anything (which keeps plurals and compounds working) but must not begin
    in the middle of another word.

    Fragments containing a dot or a slash skip the check entirely.
    "microsoft.network", "s3.amazonaws.com" and "diagnosticsettings/delete" are
    specific enough that no boundary rule adds anything, and they legitimately
    follow a letter.
    """
    if not fragment:
        return False
    if "." in fragment or "/" in fragment:
        return fragment in haystack_lower

    reference = original if original is not None and len(original) == len(haystack_lower) \
        else haystack_lower
    start = haystack_lower.find(fragment)
    while start != -1:
        if _word_starts_at(reference, start):
            return True
        start = haystack_lower.find(fragment, start + 1)
    return False


def _any_fragment(haystack_lower: str, fragments, original: str = None) -> bool:
    return any(
        matches_fragment(haystack_lower, str(f).lower(), original) for f in fragments
    )


# Splits an identifier into its words: CamelCase humps, and runs separated by
# anything that is not a letter or digit. "ListPublishingCredentials" ->
# ["list", "publishing", "credentials"]; "com.oraclecloud.objectstorage.
# deletebucket" -> ["com", "oraclecloud", "objectstorage", "deletebucket"].
_WORD_SPLIT = re.compile(r"[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])")


def _words(text: str) -> List[str]:
    return [w.lower() for w in _WORD_SPLIT.split(text or "") if w]


def derive_action(
    *,
    event_name: Optional[str],
    api_operation: Optional[str] = None,
    provider: Optional[str] = None,
    request_action: Optional[str] = None,
    read_only: Optional[bool] = None,
) -> str:
    """The action verb for an operation.

    Azure is handled first because its operation names carry a REST verb
    suffix rather than an English verb: matching "Microsoft.Compute/
    virtualMachines/write" against the English patterns finds "Write"→Update
    only by luck, and "…/networkSecurityGroups/securityRules/delete" would hit
    "Security" before it hit anything meaningful.
    """
    if provider == "Azure" and api_operation:
        suffix = api_operation.rsplit("/", 1)[-1].strip().lower()
        mapped = AZURE_VERB_SUFFIX.get(suffix)
        if mapped:
            return mapped

    # The verb is the LEADING word of an operation name — "DeleteBucket",
    # "AuthorizeSecurityGroupIngress", "ListPublishingCredentials". So the
    # first word is tried against every pattern before any later word is
    # considered, rather than scanning the whole string for whichever pattern
    # happens to sit earliest in the table.
    #
    # That ordering is what distinguishes a verb from a noun that merely looks
    # like one. "ListPublishingCredentials" contains the word "Publishing", and
    # "Publish" appears above "List" in the pattern table, so a whole-string
    # scan classified a credential READ as a deployment — which then sailed
    # past every write-oriented risk rule. Live Azure data surfaced it.
    words = _words(event_name) or _words(api_operation)
    if words:
        for fragment, action in ACTION_PATTERNS:
            if words[0].startswith(fragment.lower()):
                return action
        for word in words[1:]:
            for fragment, action in ACTION_PATTERNS:
                if word.startswith(fragment.lower()):
                    return action

    # The api_operation may carry the verb when the event name did not (Azure's
    # child events, OCI's cloud-event type).
    for word in _words(api_operation):
        for fragment, action in ACTION_PATTERNS:
            if word.startswith(fragment.lower()):
                return action

    # OCI supplies the HTTP verb of the original request, which is a real
    # answer where the name pattern found nothing.
    if request_action:
        mapped = OCI_REQUEST_ACTION.get(request_action.strip().upper())
        if mapped:
            return mapped

    # The provider's own readOnly flag is the last real signal available.
    # Everything past this is genuinely unknown, and says so.
    if read_only is True:
        return "Read"
    return "Other"


def derive_category(
    *,
    event_name: Optional[str] = None,
    event_source: Optional[str] = None,
    api_operation: Optional[str] = None,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
) -> str:
    """The functional area an operation belongs to.

    The haystack includes the resource id because Azure and OCI both encode the
    service in it (an ARM id names its provider namespace, an OCID names its
    service), which is often more specific than the operation name.
    """
    # The original casing is kept alongside the lowercased copy, because
    # CamelCase humps are what distinguish "AuthorizeSecurityGroupIngress"
    # (where "SecurityGroup" is a real word) from "StopWebSite" (where "ebs"
    # is not). Lowercasing first destroys exactly that signal.
    original = " ".join(
        part for part in (event_source, api_operation, event_name, resource_type, resource_id)
        if part
    )
    haystack = original.lower()
    for category, fragments in CATEGORY_PATTERNS:
        if _any_fragment(haystack, fragments, original):
            return category
    return "Other"


def _payload_haystack(*payloads: Any) -> str:
    """One lowercased string to scan for payload markers.

    Serialized rather than walked because the markers are values, keys and
    substrings of both, and a rule author should not have to know which.
    """
    chunks: List[str] = []
    budget = _PAYLOAD_SCAN_LIMIT
    for payload in payloads:
        if payload is None or budget <= 0:
            continue
        if isinstance(payload, str):
            text = payload
        else:
            try:
                text = json.dumps(payload, default=str)
            except Exception:
                text = str(payload)
        chunks.append(text[:budget])
        budget -= len(text)
    return " ".join(chunks).lower()


def _rule_matches(rule: Dict[str, Any], facts: Dict[str, Any]) -> bool:
    match = rule.get("match") or {}

    if "provider" in match and facts.get("provider") != match["provider"]:
        return False
    if "actor_type_any" in match and facts.get("actor_type") not in match["actor_type_any"]:
        return False
    if "status_any" in match and facts.get("status") not in match["status_any"]:
        return False
    if "category_any" in match and facts.get("category") not in match["category_any"]:
        return False
    if "action_any" in match and facts.get("action") not in match["action_any"]:
        return False
    # Word-boundary matching here too, for the same reason the derivations use
    # it: a rule keyed on "delete" must not fire on "undelete", and one keyed
    # on "listkeys" must not fire on a resource that happens to contain it.
    if "name_any" in match:
        if not _any_fragment(
            facts.get("name_haystack") or "", match["name_any"],
            facts.get("name_original"),
        ):
            return False
    if "source_any" in match:
        if not _any_fragment((facts.get("event_source") or "").lower(), match["source_any"]):
            return False
    if "payload_any" in match:
        if not _any_fragment(facts.get("payload_haystack") or "", match["payload_any"]):
            return False
    # A rule with an empty match block would tag every event. That is always a
    # mistake in a tuning file, so it never matches rather than silently
    # rewriting the whole feed.
    return bool(match)


def classify_risk(
    *,
    provider: str,
    action: str,
    category: str,
    status: str,
    actor_type: str,
    event_name: Optional[str] = None,
    api_operation: Optional[str] = None,
    event_source: Optional[str] = None,
    request_parameters: Any = None,
    response_elements: Any = None,
) -> Tuple[str, Optional[str]]:
    """Return (risk_level, risk_reason).

    `risk_reason` is the human sentence from the rule that decided it, or the
    derivation when no specific rule fired — so the badge is always
    explainable, never just asserted.
    """
    base_map = effective_base_risk()
    floor_map = effective_category_floor()

    risk = base_map.get(action, "LOW")
    # "Other" is not a verb, it is the absence of one — so it gets a sentence
    # that says that, rather than "Base risk for a Other operation", which both
    # reads badly and implies a classification that was never made.
    reason = (
        "The operation name did not yield a recognisable verb, so this carries the "
        "default risk for an unclassified operation."
        if action == "Other"
        else f"Base risk for a {action} operation."
    )

    # A write in a sensitive category outranks the verb alone. Reads are
    # excluded: listing IAM users is not a HIGH-risk act, and treating it as one
    # buries the writes that are.
    if action != "Read":
        floor = floor_map.get(category)
        if floor and RISK_ORDER.get(floor, 0) > RISK_ORDER.get(risk, 0):
            risk = floor
            reason = f"{category} operations carry a raised floor for any change."

    facts = {
        "provider": provider,
        "action": action,
        "category": category,
        "status": status,
        "actor_type": actor_type,
        "event_source": event_source,
        "name_original": f"{event_name or ''} {api_operation or ''}",
        "name_haystack": f"{event_name or ''} {api_operation or ''}".lower(),
        "payload_haystack": _payload_haystack(request_parameters, response_elements),
    }

    for rule in effective_risk_rules():
        if not _rule_matches(rule, facts):
            continue
        candidate = rule.get("risk")
        if candidate not in RISK_ORDER:
            continue

        demotes = RISK_ORDER[candidate] < RISK_ORDER.get(risk, 0)
        sanctioned = bool(rule.get("allow_lower")) or rule.get("id") == "cloud-service-routine"

        if not demotes or sanctioned:
            # The chatter rule is the one sanctioned demotion (see the module
            # docstring). It is named explicitly rather than left to a generic
            # "lowest wins", so adding a second demoting rule is a deliberate act.
            risk = candidate
            # The reason is taken even when the level does not move. A rule that
            # matched is the most specific true statement available about this
            # event, so "an IAM user was deleted" must replace the generic "base
            # risk for a Delete operation" — otherwise every rule whose level
            # happens to equal the floor silently loses its explanation, and the
            # badge becomes unjustifiable exactly where it matters most.
            reason = rule.get("why") or f"Matched rule {rule.get('id')}."
        # First match wins either way: a rule that matched has had its say, and
        # continuing would let a broader rule downstream override a narrower one.
        break

    return risk, reason


def classify(
    *,
    provider: str,
    event_name: Optional[str],
    api_operation: Optional[str] = None,
    event_source: Optional[str] = None,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    status: str = "Unknown",
    actor_type: str = "Unknown",
    read_only: Optional[bool] = None,
    request_action: Optional[str] = None,
    request_parameters: Any = None,
    response_elements: Any = None,
) -> Dict[str, Any]:
    """One call for all three labels, which is how every adapter uses it."""
    action = derive_action(
        event_name=event_name,
        api_operation=api_operation,
        provider=provider,
        request_action=request_action,
        read_only=read_only,
    )
    category = derive_category(
        event_name=event_name,
        event_source=event_source,
        api_operation=api_operation,
        resource_type=resource_type,
        resource_id=resource_id,
    )
    risk, reason = classify_risk(
        provider=provider,
        action=action,
        category=category,
        status=status,
        actor_type=actor_type,
        event_name=event_name,
        api_operation=api_operation,
        event_source=event_source,
        request_parameters=request_parameters,
        response_elements=response_elements,
    )
    return {
        "action": action,
        "event_category": category,
        "risk_level": risk,
        "risk_reason": reason,
    }


def describe_ruleset() -> Dict[str, Any]:
    """The effective ruleset, for the /events/rules endpoint.

    Exposed so "risk is configurable" is verifiable from the running service
    rather than a claim in a README.
    """
    return {
        "base_risk_by_action": effective_base_risk(),
        "category_risk_floor": effective_category_floor(),
        "risk_rules": [
            {"id": r.get("id"), "risk": r.get("risk"), "why": r.get("why"),
             "match": r.get("match")}
            for r in effective_risk_rules()
        ],
        "categories": [c for c, _ in CATEGORY_PATTERNS] + ["Other"],
    }
