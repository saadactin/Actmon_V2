"""Structured logging configuration."""
from __future__ import annotations

import logging
import sys


def setup_logging(level: str = "INFO") -> None:
    fmt = "%(asctime)s  %(levelname)-8s  %(name)s  %(message)s"
    logging.basicConfig(
        stream=sys.stdout,
        level=getattr(logging, level.upper(), logging.INFO),
        format=fmt,
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    # Quieten noisy libraries
    for noisy in ("boto3", "botocore", "urllib3", "azure", "oci"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


logger = logging.getLogger("cloud_svc")
