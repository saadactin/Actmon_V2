"""Renderers for the resource assessment report: dataset in, bytes out.

Every renderer takes the same normalized dataset from
`report_service.build_report_dataset` plus the request's `ReportLayout`, and
every renderer is a pure function -- no I/O, no DB access, so the same
dataset renders identically from `/preview` and `/generate`.
"""
