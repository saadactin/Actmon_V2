# -*- coding: utf-8 -*-
"""A failed read must not reach the UI wearing a zero.

Every numeric field in the Oracle dashboard payload is initialised to 0 and
only overwritten when its query succeeds. A connection that answered nothing
therefore arrived as a full set of zeros and scored "Health 100". The payload
now names which metrics failed; these tests pin that derivation.
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.services.oracle.oracle_monitoring_service import _failed_metric_keys


def test_no_errors_means_nothing_failed():
    assert _failed_metric_keys([]) == []
    assert _failed_metric_keys(None) == []


def test_metric_name_is_taken_from_the_prefix():
    assert _failed_metric_keys(["max_sessions: ORA-00942: table or view does not exist"]) == [
        "max_sessions"
    ]


def test_a_message_containing_colons_still_yields_one_key():
    # ORA- messages are full of colons; only the first one delimits the metric.
    keys = _failed_metric_keys(["host_cpu_sysmetric: DPY-6005: cannot connect: timed out"])
    assert keys == ["host_cpu_sysmetric"]


def test_keys_are_deduplicated_and_sorted():
    keys = _failed_metric_keys([
        "tablespaces: boom",
        "buffer_cache_hit: boom",
        "tablespaces: boom again",
    ])
    assert keys == ["buffer_cache_hit", "tablespaces"]


def test_an_entry_without_a_metric_name_is_skipped_not_guessed_at():
    # Some collectors append a bare str(exc). It names no metric, so inventing
    # one from it would silence the wrong tile.
    assert _failed_metric_keys(["connection refused"]) == []
    assert _failed_metric_keys([": orphaned colon"]) == []


def test_non_strings_do_not_break_the_derivation():
    assert _failed_metric_keys(["osstat: boom", None, 7]) == ["osstat"]


def test_a_total_collection_failure_names_every_health_input():
    # The case that produced "Health 100": the instance answered nothing.
    errors = [
        "version: x", "instance: x", "database: x",
        "active_sessions: x", "total_sessions: x", "max_sessions: x",
        "buffer_cache_hit: x", "host_cpu_sysmetric: x", "osstat: x",
        "tablespaces: x", "top_waits: x",
    ]
    keys = _failed_metric_keys(errors)
    # Each health input the dashboard scores must be represented.
    for required in ("max_sessions", "buffer_cache_hit", "osstat", "tablespaces", "top_waits"):
        assert required in keys
