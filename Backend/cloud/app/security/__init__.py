"""Unified security assessment: one canonical finding model, three views.

Read `engine.py` first — it is the only thing that produces findings, and
Security, Compliance and Alerts are all views over its output. `model.py` holds
the vocabulary every other module reads; `registry.py` holds the rules.
"""
