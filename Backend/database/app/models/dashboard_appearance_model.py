from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, UniqueConstraint
from app.database.base import Base
from datetime import datetime


class DashboardAppearanceSettings(Base):
    """Per-user, per-technology-scope visual template for gauges/indicators and
    trend charts. scope='all' is the global default every dashboard falls back
    to; a specific technology name (mysql/mssql/oracle/postgresql/mongodb/
    clickhouse/infra) overrides it for just that dashboard. Read/written via
    dashboard_appearance_routes.py, resolved per-page by DashboardScopeProvider
    + useDashboardAppearance() in the frontend."""
    __tablename__ = "dashboard_appearance_settings"
    __table_args__ = (UniqueConstraint("user_id", "scope", name="uq_dashboard_appearance_user_scope"),)

    id              = Column(Integer, primary_key=True, autoincrement=True)
    user_id         = Column(Integer, ForeignKey("user_master.user_id"), nullable=False)
    scope           = Column(String(20), nullable=False, default="all")
    indicator_style = Column(String(20), nullable=False, default="ring")   # ring | stat | donut | minimal
    chart_style     = Column(String(20), nullable=False, default="area")  # area | line | bar | barh | spark | pie | donut | scatter | gauge | bubble | gantt
    display_mode    = Column(String(10), nullable=False, default="gauge") # gauge | graph
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
