"""Every verify_*.py is declared in suite_manifest.py, and every declared
suite can actually run.

Run: venv\\Scripts\\python.exe tests\\verify_suite_manifest.py

This is Tier 0 -- the first thing run_all_tests.ps1 runs -- because its whole
job is to stop the exact failure mode this repo has already had twice:
`verify_account_refresh.py` and `verify_exposure_logic.py` existed, worked,
and were invisible to every runner because nothing declared them. A suite
that is never run is indistinguishable from a suite that always passes, and
this file is what makes that distinction impossible to lose again.

The assertions:

  A  every tests/verify_*.py file is declared in SUITES (or NON_SUITE_FILES)
     -- the reverse of what a human forgets to do.
  B  every SUITES entry's File exists on disk -- the reverse mistake, a
     renamed or deleted suite the runner would silently skip.
  C  every declared suite module compiles (parsed, not executed -- executing
     it here would run its side effects twice per test run).
  D  every declared suite's source contains a real, checkable exit path
     (sys.exit tied to main()) -- a suite that always returns 0 cannot fail,
     which is worse than a suite that doesn't exist.
  E  every declared suite silences the SQLAlchemy engine loggers, so the
     summary line stays readable in a 40-suite run.
  F  no suite defines a module-level function whose name collides with a
     production function under app/ -- the mirror-logic mistake that hid two
     real bugs in this repo (verify_account_refresh.py's old `_grade()`,
     the alerts suite's old `_rule()`). Calling the production function is
     fine; recomputing what it means is not. This check is a warning list,
     not a hard failure -- flagging a collision is often the first step
     toward fixing it, not proof that it's wrong.
"""
import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
TESTS_DIR = ROOT / "tests"
sys.path.insert(0, str(ROOT))

sys.path.insert(0, str(TESTS_DIR))
import suite_manifest  # noqa: E402

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def section(title):
    print(f"\n{title}")
    print("-" * len(title))


# -- A + B: the manifest and the filesystem agree, in both directions -------
def test_manifest_matches_filesystem():
    section("A. Every verify_*.py is declared, and every declaration exists")

    on_disk = {
        f"tests/{p.name}" for p in TESTS_DIR.glob("verify_*.py")
    }
    declared = set(suite_manifest.all_files())
    non_suite = suite_manifest.NON_SUITE_FILES

    undeclared = on_disk - declared - non_suite
    check(
        "every verify_*.py on disk is declared in suite_manifest.SUITES",
        not undeclared,
        (f"not declared: {sorted(undeclared)} -- add each to "
         f"tests/suite_manifest.py with its Area/Db/Tier, or it will never "
         f"run as part of run_all_tests.ps1.") if undeclared else "",
    )

    dangling = declared - on_disk
    check(
        "every file declared in suite_manifest.SUITES exists on disk",
        not dangling,
        (f"declared but missing: {sorted(dangling)} -- the suite was "
         f"renamed or deleted; update suite_manifest.py.") if dangling else "",
    )

    # A file cannot be both a declared suite and a declared non-suite --
    # that would silence the "is it declared?" check above for real content.
    overlap = declared & non_suite
    check(
        "no file is declared as both a suite and a non-suite",
        not overlap,
        f"listed in both: {sorted(overlap)}" if overlap else "",
    )

    # NON_SUITE_FILES itself must point at real files -- an entry for a file
    # that was deleted is dead weight hiding a real gap.
    non_suite_dangling = {
        f for f in non_suite
        if not (ROOT / f).exists()
    }
    check(
        "every NON_SUITE_FILES entry exists on disk",
        not non_suite_dangling,
        f"missing: {sorted(non_suite_dangling)}" if non_suite_dangling else "",
    )


def _has_checkable_exit(tree):
    """Does this module's exit code depend on whether a check failed?

    Builds a parent map so a bare `sys.exit(1)` can be recognised as
    conditional when it sits inside an `if` branch, then walks every call to
    `sys.exit` looking for one of three shapes: a call wrapping `main()` (the
    async/sync main-function suites), a ternary argument (the module-level
    `sys.exit(1 if fail else 0)` suites), or a non-zero constant reachable
    only inside an `ast.If` body (the `if fail: sys.exit(1)` suites, which
    fall through to an implicit 0 otherwise).
    """
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    def in_conditional(node):
        current = node
        while current in parents:
            current = parents[current]
            if isinstance(current, ast.If):
                return True
        return False

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        is_sys_exit = (
            isinstance(func, ast.Attribute) and func.attr == "exit"
            and isinstance(func.value, ast.Name) and func.value.id == "sys"
        )
        if not is_sys_exit or not node.args:
            continue
        arg = node.args[0]

        # sys.exit(main()) / sys.exit(asyncio.run(main()))
        if any(
            isinstance(sub, ast.Call) and (
                (isinstance(sub.func, ast.Name) and sub.func.id == "main")
                or (isinstance(sub.func, ast.Attribute) and sub.func.attr == "main")
            )
            for sub in ast.walk(arg)
        ):
            return True

        # sys.exit(1 if fail else 0) -- a ternary anywhere in the argument
        if any(isinstance(sub, ast.IfExp) for sub in ast.walk(arg)):
            return True

        # sys.exit(1) reached only through a conditional branch
        if isinstance(arg, ast.Constant) and isinstance(arg.value, int) \
                and arg.value != 0 and in_conditional(node):
            return True

    return False


# -- C + D + E: every declared suite is actually runnable --------------------
def test_suites_are_runnable():
    section("C-E. Every declared suite compiles, can fail, and stays quiet")

    seen_files = set()
    for entry in suite_manifest.SUITES:
        file = entry["File"]
        if file in seen_files:
            continue  # persistence's two phases share one file
        seen_files.add(file)

        path = ROOT / file
        label = f"{file}"

        if not path.exists():
            # Already reported under B; don't cascade three more failures
            # for the same root cause.
            continue

        source = path.read_text(encoding="utf-8")

        # C: parses as valid Python. ast.parse never executes the module, so
        # this cannot double-run a suite's side effects.
        try:
            ast.parse(source, filename=str(path))
            compiles = True
            compile_detail = ""
        except SyntaxError as exc:
            compiles = False
            compile_detail = f"{exc.__class__.__name__}: {exc}"
        check(f"{label} parses as valid Python", compiles, compile_detail)

        # D: has a real exit path, not a suite that always reports success.
        # Three legitimate shapes exist in this codebase and all must be
        # accepted: `sys.exit(asyncio.run(main()))` / `sys.exit(main())`;
        # a module-level ternary `sys.exit(1 if fail else 0)`; and a bare
        # `sys.exit(1)` reachable only inside an `if fail:`-shaped branch
        # (implying a clean fall-through exit 0 otherwise). AST-based, not
        # string matching -- a string search for "main()" would itself be
        # the kind of shortcut this file exists to catch elsewhere.
        try:
            exit_tree = ast.parse(source, filename=str(path))
            has_exit = _has_checkable_exit(exit_tree)
        except SyntaxError:
            has_exit = False
        check(
            f"{label} has a checkable exit path (exit code depends on "
            f"whether a check failed)",
            has_exit,
            "" if has_exit else "a suite whose exit code is a hardcoded "
                                 "constant always reports the same result "
                                 "regardless of its checks",
        )

        # E: silences the SQLAlchemy engine loggers. Suites with no DB
        # section at all (Tier 1) don't need this -- SQLAlchemy is never
        # imported, so there is nothing to silence.
        if entry.get("Db"):
            silences = "sqlalchemy.engine" in source
            check(
                f"{label} silences the SQLAlchemy engine loggers (DB suite)",
                silences,
                "" if silences else "a DB-backed suite that doesn't silence "
                                     "SQLAlchemy's echo drowns the PASS/FAIL "
                                     "summary in a 40-suite run",
            )


# -- F: no suite reimplements a production function under its own name ------
# A collision here is a strong smell, not automatically wrong -- constructing
# a fixture object (e.g. a local `_rule()` that builds a CloudAlertRule) is
# fine. What's not fine is a local function that recomputes what a real
# function DECIDES. Anything on this list has been reviewed and is a
# legitimate fixture builder, not a mirror of production logic.
ALLOWED_NAME_COLLISIONS = {
    ("verify_account_refresh.py", "main"),   # every suite has one; not a collision
}


def _production_function_names():
    """Every module-level `def name(...)` under app/, keyed by name ->
    the modules that define it. Collisions within app/ itself (e.g. two
    services each having their own private `_validate`) are expected and
    excluded by requiring the name to be reasonably specific: at least 4
    characters, not a dunder, not a common single-word helper name that
    naturally repeats (get/set/run/main/init are excluded)."""
    common = {"main", "run", "get", "set", "init", "build", "load", "save"}
    names = {}
    for path in (ROOT / "app").rglob("*.py"):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = node.name
                if name.startswith("_") or name in common or len(name) < 4:
                    continue
                names.setdefault(name, set()).add(str(path.relative_to(ROOT)))
    return names


def test_no_mirrored_logic():
    section("F. No suite reimplements a production function under its name")

    prod_names = _production_function_names()
    collisions = []

    for entry in suite_manifest.SUITES:
        path = ROOT / entry["File"]
        if not path.exists():
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = node.name
                key = (pathlib.Path(entry["File"]).name, name)
                if key in ALLOWED_NAME_COLLISIONS:
                    continue
                if not name.startswith("_"):
                    continue  # only private, test-local helpers are suspect
                bare = name.lstrip("_")
                if bare in prod_names:
                    collisions.append(
                        f"{entry['File']}::{name} shadows {bare}() in "
                        f"{', '.join(sorted(prod_names[bare]))}"
                    )

    # This is reported as information, not a hard failure: a name collision
    # is worth a human's eyes (is this a mirror, or a legitimate private
    # helper with an unlucky name?), but auto-failing risks the same fate as
    # an over-eager linter that gets silenced wholesale.
    if collisions:
        print("  [INFO] possible mirrored-logic collisions (review, don't "
              "auto-fail):")
        for c in sorted(collisions):
            print(f"           {c}")
    check(
        "the mirrored-logic scan ran (see [INFO] lines above for any hits)",
        True,
    )


def main():
    print("Suite manifest: every verify_*.py declared, and every declared suite runnable")
    print("=" * 78)
    test_manifest_matches_filesystem()
    test_suites_are_runnable()
    test_no_mirrored_logic()

    print("\n" + "=" * 78)
    print(f"PASS {len(ok)}   FAIL {len(fail)}   SKIP 0")
    if fail:
        print("\nFailed:")
        for f in fail:
            print(f"  - {f}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
