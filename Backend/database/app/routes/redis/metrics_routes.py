"""
Metrics pipeline routes — read the Redis hot tier and ClickHouse history tier.

  GET /api/v1/metrics/pipeline/status                     → health of both tiers
  GET /api/v1/metrics/live/{agent_name}?limit=            → newest-first ring (Redis)
  GET /api/v1/metrics/browse?kind=&tech=                  → agents by category + latest (Redis)
  GET /api/v1/metrics/history/{agent_name}?minutes=       → per-agent history (ClickHouse)
  GET /api/v1/metrics/history?kind=database&tech=mysql    → category history (ClickHouse)

Segregation dimensions: kind ∈ infra|database · tech ∈ host|mysql|postgresql|oracle|mssql|…
Callers should treat empty results as "tier offline" and fall back to the existing
PostgreSQL agent_metrics endpoints (unchanged).
"""
from typing import Optional

from fastapi import APIRouter

from app.services.common import metrics_pipeline

router = APIRouter(prefix="/api/v1/metrics", tags=["Metrics Pipeline"])


@router.get("/pipeline/status")
def pipeline_status():
    return metrics_pipeline.status()


@router.get("/live/{agent_name}")
def metrics_live(agent_name: str, limit: int = 240):
    return {"agent": agent_name, "source": "redis",
            "samples": metrics_pipeline.live(agent_name, limit)}


@router.get("/browse")
def metrics_browse(kind: Optional[str] = None, tech: Optional[str] = None):
    return {"source": "redis", "categories": metrics_pipeline.browse(kind, tech)}


@router.get("/history/{agent_name}")
def metrics_history_agent(agent_name: str, minutes: int = 60, conn_id: Optional[int] = None):
    return {"agent": agent_name, "source": "clickhouse",
            "samples": metrics_pipeline.history(agent_name=agent_name, minutes=minutes, conn_id=conn_id)}


@router.get("/history")
def metrics_history_category(kind: Optional[str] = None, tech: Optional[str] = None,
                             conn_id: Optional[int] = None, minutes: int = 60):
    return {"kind": kind, "tech": tech, "conn_id": conn_id, "source": "clickhouse",
            "samples": metrics_pipeline.history(minutes=minutes, kind=kind, tech=tech, conn_id=conn_id)}


@router.get("/stable/{agent_name}")
def metrics_stable(agent_name: str):
    """Current stable facts (version, databases, config limits) — stored once,
    updated only on change."""
    return {"agent": agent_name, "source": "postgresql", "facts": metrics_pipeline.stable(agent_name)}


@router.get("/stable-changes")
def metrics_stable_changes(agent: Optional[str] = None, kind: Optional[str] = None,
                           tech: Optional[str] = None, minutes: int = 1440):
    """Change log: what stable fact changed, old → new, when (ClickHouse)."""
    return {"agent": agent, "source": "clickhouse",
            "changes": metrics_pipeline.stable_history(agent_name=agent, minutes=minutes,
                                                       kind=kind, tech=tech)}
