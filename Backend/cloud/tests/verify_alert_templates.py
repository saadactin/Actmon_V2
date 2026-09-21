"""Alert rule templates: every template describes a rule the engine can run.

Run: venv\\Scripts\\python.exe tests\\verify_alert_templates.py

`templates_catalog.validate_all()` already exists, already documents itself as
"called by the test suite", and until this file existed **nothing called it**.
A template that sets a field its condition does not read, or omits a required
one, would only fail when somebody clicked it in the builder -- at which point
the error surfaces as a 422 on a rule they were trying to create, not as a
problem with the template they picked.

So section A is one line, and it is the most valuable line in the file.

The rest guards the properties `validate_all` does not cover:

  B  every template is applyable: severities the analytics can bucket,
     categories the catalog resolves, pacing values the engine accepts.
  C  the recommended subset is a real subset, and applying all of it would
     not collide on the partial unique index over (account_id, name).
  D  `needs_input` names fields the condition actually reads -- otherwise the
     builder opens on a step that has nothing to show.
"""
import logging
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

from app.services.alerts import catalog, templates_catalog as tc  # noqa: E402

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def section(title):
    print(f"\n{title}")
    print("-" * len(title))


def test_validate_all():
    section("A. Every template describes a condition the engine can evaluate")

    problems = tc.validate_all()
    check("templates_catalog.validate_all() reports no problems",
          problems == [],
          "; ".join(problems[:4]) if problems else "")
    check("there is a non-trivial catalogue to validate",
          len(tc.TEMPLATES) >= 10, f"{len(tc.TEMPLATES)} templates")
    check("every template's key matches the dict key it is filed under",
          all(key == template.key for key, template in tc.TEMPLATES.items()))


def test_shape():
    section("B. Every template is applyable as written")

    # Severity must be something the alert analytics can bucket. Importing the
    # real list rather than restating it -- a severity added to the engine and
    # not here would otherwise pass forever.
    from app.models.alert_rule import CATEGORIES, SEVERITIES

    for key, template in tc.TEMPLATES.items():
        check(f"{key}: severity {template.severity!r} is one the engine defines",
              template.severity in SEVERITIES,
              f"known: {sorted(SEVERITIES)}")

    for key, template in tc.TEMPLATES.items():
        try:
            category = template.category
            resolved = True
        except Exception as exc:  # noqa: BLE001
            category, resolved = str(exc), False
        check(f"{key}: category resolves through the condition catalog",
              resolved and category in CATEGORIES,
              f"got {category!r}")

    for key, template in tc.TEMPLATES.items():
        check(f"{key}: has a label, a summary and a rationale",
              bool(template.label and template.summary and template.rationale))
        # The rationale is what the builder shows under the label to answer
        # "why would I want this" -- a one-word placeholder defeats it.
        check(f"{key}: the rationale is a real sentence, not a placeholder",
              len(template.rationale) > 25, template.rationale[:40])

    for key, template in tc.TEMPLATES.items():
        check(f"{key}: evaluation interval is at least 60s",
              template.evaluation_interval_seconds >= 60,
              str(template.evaluation_interval_seconds))
        check(f"{key}: cooldown and repeat interval are non-negative",
              template.cooldown_seconds >= 0 and template.repeat_interval_seconds >= 0)
        check(f"{key}: consecutive_breaches_required is at least 1 "
              f"(0 would mean a rule that can never fire)",
              template.consecutive_breaches_required >= 1,
              str(template.consecutive_breaches_required))
        check(f"{key}: min_duration_seconds is non-negative",
              template.min_duration_seconds >= 0)


def test_recommended():
    section("C. The recommended subset is real, and applying it does not collide")

    check("every RECOMMENDED key is a template that exists",
          all(key in tc.TEMPLATES for key in tc.RECOMMENDED),
          str([k for k in tc.RECOMMENDED if k not in tc.TEMPLATES]))
    check("RECOMMENDED is a strict subset, not the whole catalogue",
          0 < len(tc.RECOMMENDED) < len(tc.TEMPLATES),
          f"{len(tc.RECOMMENDED)} of {len(tc.TEMPLATES)}")
    check("RECOMMENDED has no duplicates",
          len(set(tc.RECOMMENDED)) == len(tc.RECOMMENDED))

    # cloud_alert_rules carries a partial unique index over
    # (account_id, name) WHERE deleted_at IS NULL. Two templates sharing a
    # suggested_name means applying both silently 409s on the second.
    names = [t.suggested_name for t in tc.TEMPLATES.values()]
    duplicates = sorted({n for n in names if names.count(n) > 1})
    check("no two templates share a suggested_name -- the partial unique index "
          "over (account_id, name) would refuse the second one",
          not duplicates, str(duplicates))

    recommended_names = [tc.TEMPLATES[k].suggested_name for k in tc.RECOMMENDED]
    check("applying every recommended template at once produces unique names",
          len(set(recommended_names)) == len(recommended_names),
          str(recommended_names))


def test_payload():
    section("D. The payload the API serves, and the inputs the builder asks for")

    full = tc.payload()
    check("the full payload carries every template",
          len(full["templates"]) == len(tc.TEMPLATES),
          f"{len(full['templates'])} of {len(tc.TEMPLATES)}")

    recommended = tc.payload(recommended_only=True)
    check("the recommended-only payload carries ONLY the recommended ones, "
          "not silently all of them",
          len(recommended["templates"]) == len(tc.RECOMMENDED),
          f"{len(recommended['templates'])} vs {len(tc.RECOMMENDED)}")
    check("both payloads state which keys are recommended",
          full["recommended"] == list(tc.RECOMMENDED)
          and recommended["recommended"] == list(tc.RECOMMENDED))
    check("the payload says nothing is created until it is saved",
          "Nothing is created" in full["note"], full["note"][:60])
    check("the payload says recommended rules arrive disabled",
          "disabled" in full["note"])

    # needs_input drives which step the builder opens on. A field named here
    # that the condition does not read opens the operator on a step showing
    # nothing.
    for key, template in tc.TEMPLATES.items():
        if not template.needs_input:
            continue
        condition = catalog.get(template.condition_type)
        known = {f.key for f in condition.fields}
        unknown = [f for f in template.needs_input if f not in known]
        check(f"{key}: every needs_input field is one {template.condition_type} reads",
              not unknown, f"unknown: {unknown}; reads: {sorted(known)}")

    for template in tc.TEMPLATES.values():
        rendered = template.to_dict()
        check(f"{template.key}: to_dict carries the fields the builder needs",
              all(k in rendered for k in
                  ("key", "label", "summary", "rationale", "category",
                   "condition_type", "condition_config", "severity",
                   "suggested_name", "needs_input")))


def test_unknown_key():
    section("E. An unknown template key fails usefully")

    try:
        tc.get("not-a-template")
        raised = False
        message = ""
    except catalog.ValidationError as exc:
        raised, message = True, str(exc)
    except Exception as exc:  # noqa: BLE001
        raised, message = False, f"raised {type(exc).__name__} instead: {exc}"

    check("an unknown key raises ValidationError, not KeyError", raised, message)
    check("the message names at least one real template, so the caller can "
          "see what IS available",
          any(key in message for key in tc.TEMPLATES), message[:80])

    first = next(iter(tc.TEMPLATES))
    check("a known key returns its template", tc.get(first).key == first)


def main():
    print("Alert templates: every template describes a rule the engine can run")
    print("=" * 70)
    test_validate_all()
    test_shape()
    test_recommended()
    test_payload()
    test_unknown_key()

    print("\n" + "=" * 70)
    print(f"PASS {len(ok)}   FAIL {len(fail)}   SKIP 0")
    if fail:
        print("\nFailed:")
        for f in fail:
            print(f"  - {f}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
