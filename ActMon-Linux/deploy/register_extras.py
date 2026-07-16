"""Idempotently register menu entries not in the static config seed (e.g. Sales).
Run under the backend venv from the deployed server."""
import os, sys
from pathlib import Path

BE = Path("/opt/actmon/backend/database")
# load .env so the DB connection has credentials
env = BE / ".env"
if env.is_file():
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("="); os.environ.setdefault(k.strip(), v.strip())
sys.path.insert(0, str(BE))
from sqlalchemy import text
from app.database.connection import engine

FULL = 255
MODULES = [("SALES", "Sales", "/sales", "sales")]
PAGES = [
    ("/sales", "Sales", "SALES", True),
    ("/sales/register", "Register Organization", "SALES", False),
    ("/sales/about", "ActMon Information", "SALES", False),
    ("/sales/benefits", "Benefits of ActMon", "SALES", False),
    ("/sales/docs", "Product Documentation", "SALES", False),
]

with engine.begin() as c:
    mod_id = {}
    for code, name, route, icon in MODULES:
        mid = c.execute(text("SELECT module_id FROM module_master WHERE module_code=:c"), {"c": code}).scalar()
        if not mid:
            o = (c.execute(text("SELECT COALESCE(MAX(display_order),0) FROM module_master")).scalar() or 0) + 1
            mid = c.execute(text("INSERT INTO module_master (org_id,module_name,module_code,module_route,module_icon,display_order,is_active,created_by,created_at) VALUES (1,:n,:c,:r,:i,:o,TRUE,1,now()) RETURNING module_id"),
                            {"n": name, "c": code, "r": route, "i": icon, "o": o}).scalar()
            print("created module", code, mid)
        else:
            print("module exists", code, mid)
        mod_id[code] = mid

    mx = c.execute(text("SELECT COALESCE(MAX(display_order),0) FROM page_master")).scalar() or 0
    for url, name, mcode, menu in PAGES:
        pid = c.execute(text("SELECT page_id FROM page_master WHERE page_url=:u"), {"u": url}).scalar()
        if not pid:
            mx += 1
            code = url.strip("/").upper().replace("/", "_").replace("-", "_")
            pid = c.execute(text("INSERT INTO page_master (org_id,module_id,parent_id,page_code,page_name,page_url,display_order,is_menu,is_active,created_by,created_at) VALUES (1,:m,0,:c,:n,:u,:o,:menu,TRUE,1,now()) RETURNING page_id"),
                            {"m": mod_id[mcode], "c": code, "n": name, "u": url, "o": mx, "menu": menu}).scalar()
            print("  + page", url, pid)
        else:
            print("  = page exists", url, pid)
        if not c.execute(text("SELECT 1 FROM group_role_page_permission WHERE role_id=1 AND page_id=:p AND deleted_at IS NULL"), {"p": pid}).scalar():
            c.execute(text("INSERT INTO group_role_page_permission (org_id,role_id,page_id,permission,is_active,created_by,created_at) VALUES (1,1,:p,:f,TRUE,1,now())"), {"p": pid, "f": FULL})
            print("    granted Super Admin")
    print("extras registered.")
