from sqlalchemy import Column, Integer, String, Boolean, Text, DateTime, ForeignKey, Float
from app.database.base import Base
from datetime import datetime


class CosmosQueryLog(Base):
    """Every call ActMon's own backend makes to a Cosmos DB connection — list
    databases/containers, browse documents, ad-hoc queries, connection tests —
    timed and recorded here. This is how "query count / avg response time /
    slow queries / success-failure count / error logs" are shown WITHOUT
    needing Azure Monitor or Log Analytics: we're the client making the calls,
    so we just measure the ones we already make. Adds no extra Cosmos load."""
    __tablename__ = "cosmos_query_log"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    connection_id = Column(Integer, ForeignKey("connection_master.id"), nullable=False, index=True)
    operation      = Column(String(50), nullable=False)   # list_databases | list_containers | browse_items | custom_query | test_connection | document_count | container_details | document_stats
    detail         = Column(String(500))                  # e.g. "db/container" or a truncated query string
    duration_ms    = Column(Integer)
    request_charge = Column(Float)     # RU cost of this call, from Cosmos's own response headers
    result_value   = Column(Float)     # e.g. a logged document count, for building a real growth-over-time chart
    storage_bytes  = Column(Float)     # documentsSize from x-ms-resource-usage, for a real storage-growth chart
    activity_id    = Column(String(64))    # Cosmos's own x-ms-activity-id header — for support/diagnostics correlation
    error_type     = Column(String(120))   # exception class name, e.g. "CosmosHttpResponseError"
    http_status_code = Column(Integer)     # e.g. 401, 404, 429 — from the SDK exception when available
    success        = Column(Boolean, nullable=False, default=True)
    error_message  = Column(Text)
    created_at     = Column(DateTime, default=datetime.utcnow, index=True)
