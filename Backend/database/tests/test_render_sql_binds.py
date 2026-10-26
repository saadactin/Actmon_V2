"""_render_sql inlines binds for agent-routed queries; names must not collide."""
from app.services.common.db_proxy_service import _render_sql


def test_ten_or_more_binds_do_not_collide():
    params = {f"n{i}": f"v{i}" for i in range(12)}
    sql = "x IN (" + ", ".join(f":n{i}" for i in range(12)) + ")"
    out = _render_sql(sql, params)
    assert out == "x IN (" + ", ".join(f"'v{i}'" for i in range(12)) + ")"


def test_statistic_names_with_parentheses_stay_quoted():
    out = _render_sql("n.name IN (:n0, :n1)", {"n0": "parse count (total)", "n1": "sorts (disk)"})
    assert out == "n.name IN ('parse count (total)', 'sorts (disk)')"


def test_prefix_names_and_quotes():
    out = _render_sql("a = :inst AND b = :instance AND c = :s", {"inst": 1, "instance": 2, "s": "O'Neil"})
    assert out == "a = 1 AND b = 2 AND c = 'O''Neil'"


def test_backslashes_kept():
    assert _render_sql("p = :p", {"p": r"C:\x\1"}) == r"p = 'C:\x\1'"
