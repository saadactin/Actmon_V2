"""
SQLAlchemy ORM models for the Access-Control / Administration (RBAC) schema.

These mirror the real `actmon` Postgres tables created by the admin-masters migrations
(organization → department/designation/status → employee → role/module/page/permission →
group_role_page_permission → user → session/login/password history → audit_log).

The application writes through stored procedures, so these models are primarily for ORM
reads, type-safe queries, FK documentation and tooling. Column names/types/nullability
match the live schema exactly. Audit columns (created_by/modified_by/deleted_by) are kept
as plain integers (not FKs) to avoid an organization↔user create_all dependency cycle.
"""
from sqlalchemy import (
    Column, Integer, BigInteger, String, Boolean, DateTime, Date, Text, ForeignKey
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from app.database.base import Base


# ── Status (lookup) ────────────────────────────────────────────────────────────
class StatusMaster(Base):
    __tablename__ = "status_master"

    status_id          = Column(Integer, primary_key=True, autoincrement=True)
    status_code        = Column(String(50),  nullable=False)
    status_name        = Column(String(100), nullable=False)
    status_description = Column(String(250))
    is_active          = Column(Boolean, nullable=False, default=True)
    org_id             = Column(Integer, nullable=False, default=1)
    created_by         = Column(Integer, nullable=False)
    created_at         = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by        = Column(Integer)
    modified_at        = Column(DateTime)
    deleted_by         = Column(Integer)
    deleted_at         = Column(DateTime)


# ── Organization (tenant root) ──────────────────────────────────────────────────
class OrganizationMaster(Base):
    __tablename__ = "organization_master"

    org_id              = Column(Integer, primary_key=True, autoincrement=True)
    org_name            = Column(String(120), nullable=False)
    legal_name          = Column(String(150), nullable=False)
    gst_number          = Column(String(30))
    pan_number          = Column(String(20))
    registration_no     = Column(String(50))
    contact_person_name = Column(String(120))
    contact_no          = Column(String(25), nullable=False)
    alternate_contact_no= Column(String(25))
    email_id            = Column(String(200), nullable=False)
    website_url         = Column(String(200))
    logo_path           = Column(String(300))
    country_name        = Column(String(150), nullable=False)
    state_name          = Column(String(150), nullable=False)
    city_name           = Column(String(150), nullable=False)
    address_line1       = Column(String(250))
    address_line2       = Column(String(250))
    pincode             = Column(String(15))
    status_id           = Column(Integer, ForeignKey("status_master.status_id"), nullable=False)
    is_active           = Column(Boolean, nullable=False, default=True)
    created_by          = Column(Integer, nullable=False)
    created_at          = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by         = Column(Integer)
    modified_at         = Column(DateTime)
    deleted_by          = Column(Integer)
    deleted_at          = Column(DateTime)


# ── Department ───────────────────────────────────────────────────────────────────
class DepartmentMaster(Base):
    __tablename__ = "department_master"

    department_id   = Column(Integer, primary_key=True, autoincrement=True)
    org_id          = Column(Integer, ForeignKey("organization_master.org_id"), nullable=False)
    department_code = Column(String(50),  nullable=False)
    department_name = Column(String(150), nullable=False)
    description     = Column(String(250))
    is_active       = Column(Boolean, nullable=False, default=True)
    created_by      = Column(Integer, nullable=False)
    created_at      = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by     = Column(Integer)
    modified_at     = Column(DateTime)
    deleted_by      = Column(Integer)
    deleted_at      = Column(DateTime)


# ── Designation ────────────────────────────────────────────────────────────────
class DesignationMaster(Base):
    __tablename__ = "designation_master"

    designation_id   = Column(Integer, primary_key=True, autoincrement=True)
    org_id           = Column(Integer, ForeignKey("organization_master.org_id"), nullable=False)
    designation_code = Column(String(50),  nullable=False)
    designation_name = Column(String(150), nullable=False)
    description      = Column(String(250))
    is_active        = Column(Boolean, nullable=False, default=True)
    created_by       = Column(Integer, nullable=False)
    created_at       = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by      = Column(Integer)
    modified_at      = Column(DateTime)
    deleted_by       = Column(Integer)
    deleted_at       = Column(DateTime)


# ── Employee ───────────────────────────────────────────────────────────────────
class EmployeeMaster(Base):
    __tablename__ = "employee_master"

    employee_id          = Column(Integer, primary_key=True, autoincrement=True)
    org_id               = Column(Integer, ForeignKey("organization_master.org_id"), nullable=False)
    employee_code        = Column(String(50),  nullable=False)
    employee_name        = Column(String(150), nullable=False)
    email_id             = Column(String(200))
    mobile_no            = Column(String(20))
    department_id        = Column(Integer, ForeignKey("department_master.department_id"))
    designation_id       = Column(Integer, ForeignKey("designation_master.designation_id"))
    joining_date         = Column(Date)
    reporting_manager_id = Column(Integer, ForeignKey("employee_master.employee_id"))
    employment_status_id = Column(Integer, ForeignKey("status_master.status_id"))
    is_active            = Column(Boolean, nullable=False, default=True)
    created_by           = Column(Integer, nullable=False)
    created_at           = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by          = Column(Integer)
    modified_at          = Column(DateTime)
    deleted_by           = Column(Integer)
    deleted_at           = Column(DateTime)


# ── Role ──────────────────────────────────────────────────────────────────────
class Role(Base):
    __tablename__ = "role"

    role_id          = Column(Integer, primary_key=True, autoincrement=True)
    org_id           = Column(Integer, ForeignKey("organization_master.org_id"), nullable=False)
    role_name        = Column(String(120), nullable=False)
    role_description = Column(String(250))
    is_active        = Column(Boolean, nullable=False, default=True)
    created_by       = Column(Integer, nullable=False)
    created_at       = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by      = Column(Integer)
    modified_at      = Column(DateTime)
    deleted_by       = Column(Integer)
    deleted_at       = Column(DateTime)


# ── Module ───────────────────────────────────────────────────────────────────
class ModuleMaster(Base):
    __tablename__ = "module_master"

    module_id          = Column(Integer, primary_key=True, autoincrement=True)
    org_id             = Column(Integer, ForeignKey("organization_master.org_id"), nullable=False)
    module_name        = Column(String(100), nullable=False)
    module_code        = Column(String(50),  nullable=False)
    module_description = Column(String(300))
    module_route       = Column(String(200))
    module_icon        = Column(String(100))
    display_order      = Column(Integer, nullable=False, default=1)
    is_active          = Column(Boolean, nullable=False, default=True)
    created_by         = Column(Integer, nullable=False)
    created_at         = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by        = Column(Integer)
    modified_at        = Column(DateTime)
    deleted_by         = Column(Integer)
    deleted_at         = Column(DateTime)


# ── Page ───────────────────────────────────────────────────────────────────────
class PageMaster(Base):
    __tablename__ = "page_master"

    page_id          = Column(Integer, primary_key=True, autoincrement=True)
    org_id           = Column(Integer, ForeignKey("organization_master.org_id"), nullable=False)
    module_id        = Column(Integer, ForeignKey("module_master.module_id"), nullable=False)
    parent_id        = Column(Integer, nullable=False, default=0)
    page_code        = Column(String(100), nullable=False)
    page_name        = Column(String(150), nullable=False)
    page_url         = Column(String(250))
    mobile_url       = Column(String(250))
    icon_name        = Column(String(100))
    page_description = Column(String(300))
    display_order    = Column(Integer, nullable=False, default=0)
    is_menu          = Column(Boolean, nullable=False, default=True)
    is_active        = Column(Boolean, nullable=False, default=True)
    created_by       = Column(Integer, nullable=False)
    created_at       = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by      = Column(Integer)
    modified_at      = Column(DateTime)
    deleted_by       = Column(Integer)
    deleted_at       = Column(DateTime)


# ── Permission (catalog of permission bits) ──────────────────────────────────────
class Permission(Base):
    __tablename__ = "permission"

    permission_id    = Column(Integer, primary_key=True, autoincrement=True)
    permission_value = Column(Integer, nullable=False)
    permission_name  = Column(String(150), nullable=False)
    org_id           = Column(Integer, nullable=False, default=1)
    is_active        = Column(Boolean, nullable=False, default=True)
    created_by       = Column(Integer, nullable=False)
    created_at       = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by      = Column(Integer)
    modified_at      = Column(DateTime)
    deleted_by       = Column(Integer)
    deleted_at       = Column(DateTime)


# ── Group Role Page Permission (role × page → permission bitmask) ────────────────
class GroupRolePagePermission(Base):
    __tablename__ = "group_role_page_permission"

    page_permission_id     = Column(Integer, primary_key=True, autoincrement=True)
    org_id                 = Column(Integer, ForeignKey("organization_master.org_id"), nullable=False)
    role_id                = Column(Integer, ForeignKey("role.role_id"), nullable=False)
    page_id                = Column(Integer, ForeignKey("page_master.page_id"), nullable=False)
    permission             = Column(Integer, nullable=False)
    permission_description = Column(String(500))
    is_active              = Column(Boolean, nullable=False, default=True)
    created_by             = Column(Integer, nullable=False)
    created_at             = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by            = Column(Integer)
    modified_at            = Column(DateTime)
    deleted_by             = Column(Integer)
    deleted_at             = Column(DateTime)


# ── User (login account) ─────────────────────────────────────────────────────────
class UserMaster(Base):
    __tablename__ = "user_master"

    user_id               = Column(Integer, primary_key=True, autoincrement=True)
    org_id                = Column(Integer, ForeignKey("organization_master.org_id"), nullable=False)
    role_id               = Column(Integer, ForeignKey("role.role_id"), nullable=False)
    user_name             = Column(String(100), nullable=False)
    password_hash         = Column(String(255), nullable=False)
    employee_id           = Column(Integer, ForeignKey("employee_master.employee_id"), nullable=False)
    failed_login_attempts = Column(Integer, nullable=False, default=0)
    account_locked        = Column(Boolean, nullable=False, default=False)
    last_login_at         = Column(DateTime)
    is_active             = Column(Boolean, nullable=False, default=True)
    created_by            = Column(Integer, nullable=False)
    created_at            = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    modified_by           = Column(Integer)
    modified_at           = Column(DateTime)
    deleted_by            = Column(Integer)
    deleted_at            = Column(DateTime)


# ── User Session ─────────────────────────────────────────────────────────────────
class UserSession(Base):
    __tablename__ = "user_session"

    session_id    = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id       = Column(Integer, ForeignKey("user_master.user_id"), nullable=False)
    session_token = Column(String(500), nullable=False)
    login_time    = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    expiry_time   = Column(DateTime, nullable=False)
    ip_address    = Column(String(50))
    device_name   = Column(String(150))
    is_active     = Column(Boolean, nullable=False, default=True)
    org_id        = Column(Integer, nullable=False, default=1)


# ── Login History ────────────────────────────────────────────────────────────────
class LoginHistory(Base):
    __tablename__ = "login_history"

    login_history_id = Column(BigInteger, primary_key=True, autoincrement=True)
    org_id           = Column(Integer)
    user_id          = Column(Integer, ForeignKey("user_master.user_id"))
    login_time       = Column(DateTime, nullable=False, server_default=func.current_timestamp())
    logout_time      = Column(DateTime)
    login_status     = Column(Boolean)
    ip_address       = Column(String(50))
    device_name      = Column(String(150))
    browser_name     = Column(String(150))
    operating_system = Column(String(150))


# ── Password History ─────────────────────────────────────────────────────────────
class PasswordHistory(Base):
    __tablename__ = "password_history"

    password_history_id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id             = Column(Integer, ForeignKey("user_master.user_id"), nullable=False)
    password_hash       = Column(String(255), nullable=False)
    org_id              = Column(Integer, nullable=False, default=1)
    created_at          = Column(DateTime, nullable=False, server_default=func.current_timestamp())


# ── Audit Log ────────────────────────────────────────────────────────────────────
class AuditLog(Base):
    __tablename__ = "audit_log"

    audit_id    = Column(BigInteger, primary_key=True, autoincrement=True)
    org_id      = Column(Integer)
    user_id     = Column(Integer)
    table_name  = Column(String(150), nullable=False)
    record_id   = Column(BigInteger)
    action_type = Column(String(20), nullable=False)
    old_data    = Column(JSONB)
    new_data    = Column(JSONB)
    ip_address  = Column(String(50))
    user_agent  = Column(Text)
    created_at  = Column(DateTime, nullable=False, server_default=func.current_timestamp())
