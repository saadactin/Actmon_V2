"""
ActMon Host Agent (Windows)
===========================
A small, dependency-light monitoring agent packaged into actmon-agent.exe and
installed by actmon-agent.msi.

Configuration is read from (in priority order):
  1. Command-line:  actmon-agent.exe --token <t> --url <u>
  2. Registry:      HKLM\\SOFTWARE\\ActMon\\Agent  (Token, Url)  [written by the MSI]
  3. Environment:   ACTMON_ACCESS_TOKEN / ACTMON_URL

On start it enrolls against the token to resolve its agent identity, then pushes
host CPU / memory to <url>/agents/data every ACTMON_INTERVAL seconds (default 15).
"""

import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request

# Production DB hosts run whatever Python they shipped with — the agent adapts to
# them, never the other way around. Everything below is written for Python >= 3.5
# (no f-strings, no subprocess capture_output/text kwargs). Fail with a clear
# message rather than a cryptic traceback if the interpreter is older still.
if sys.version_info < (3, 5):
    sys.stderr.write("ActMon Agent requires Python 3.5 or newer (found %s). "
                     "Ask ActMon support for the legacy shell agent for this host.\n"
                     % sys.version.split()[0])
    sys.exit(1)


def _read_registry():
    """Return (token, url) from HKLM\\SOFTWARE\\ActMon\\Agent, or (None, None).

    Windows-only. On Linux/macOS the registry doesn't exist and `import winreg` raises
    ModuleNotFoundError (an ImportError, NOT an OSError) — which would crash the agent
    on start. Short-circuit off Windows and also catch ImportError defensively, so the
    agent falls through to reading the token/URL from the environment (agent.conf)."""
    if os.name != "nt":
        return None, None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\ActMon\Agent") as k:
            token = _reg_get(k, "Token")
            url = _reg_get(k, "Url")
            return token, url
    except (OSError, ImportError):
        return None, None


def _reg_get(key, name):
    try:
        import winreg
        val, _ = winreg.QueryValueEx(key, name)
        return val or None
    except (OSError, ImportError):
        return None


def _arg(name):
    """Read a --name value from argv."""
    flag = "--" + name
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def _resolve_config():
    token = _arg("token")
    url = _arg("url")
    if not token or not url:
        reg_token, reg_url = _read_registry()
        token = token or reg_token
        url = url or reg_url
    token = token or os.environ.get("ACTMON_ACCESS_TOKEN")
    url = url or os.environ.get("ACTMON_URL")
    if url:
        url = url.rstrip("/")
    return token, url


def _post(url, payload, timeout=15):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_text(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


_LOG_PATH = None


def _log(msg):
    """Print to stdout AND append to C:\\ProgramData\\ActMon\\agent.log — the agent runs
    as a SYSTEM task with no console, so the file log is the only way to see failures."""
    line = "%s  %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    global _LOG_PATH
    try:
        if _LOG_PATH is None:
            base = os.environ.get("ProgramData") or r"C:\ProgramData"
            _LOG_PATH = os.path.join(base, "ActMon", "agent.log")
            os.makedirs(os.path.dirname(_LOG_PATH), exist_ok=True)
        # keep it from growing forever
        try:
            if os.path.isfile(_LOG_PATH) and os.path.getsize(_LOG_PATH) > 512 * 1024:
                os.replace(_LOG_PATH, _LOG_PATH + ".1")
        except OSError:
            pass
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:  # noqa: BLE001 — logging must never crash the agent
        pass


IS_WINDOWS = os.name == "nt"


def _run_cmd(args, timeout=60):
    """subprocess.run with output capture that also works on Python 3.6 (RHEL/CentOS 8,
    Ubuntu 18.04 — common on older DB hosts). `capture_output=`/`text=` are 3.7+; on 3.6
    the unknown kwarg falls through to Popen.__init__ and crashes the agent."""
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=timeout)


def collect_windows(collector_ps):
    """Run the same PowerShell collector the SSH path runs; return its raw output."""
    b64 = base64.b64encode(collector_ps.encode("utf-16-le")).decode()
    proc = _run_cmd(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", b64])
    return proc.stdout


def collect_linux(collector_sh):
    """Run the same shell collector the SSH/bash path runs on Linux; return its raw
    output. The agent runs on the host, so localhost paths resolve correctly and the
    backend parses this identically to the SSH-collected output."""
    proc = _run_cmd(["bash", "-c", collector_sh])
    return proc.stdout


def _get_json(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ─────────────────────────────────────────────────────────────
# Interactive job channel — file edit / firewall / services / reboot.
# Mirrors the Linux agent: long-poll /agents/fs-poll, run the op locally with
# PowerShell / Python, and POST the base64 result to /agents/fs-result. The
# backend parsers expect the SAME output formats the Linux agent produces
# (ls -lAH lines, SIZE:<n> + bytes, OK:/ERR:) plus WINFW| lines for firewall.
# ─────────────────────────────────────────────────────────────
_ETC_DIR = r"C:\Windows\System32\drivers\etc"
# Editable Windows config files (the ones that actually live on disk — most network
# settings are registry/netsh, but these text files are commonly edited).
_WIN_CONFIG_FILES = [
    (r"C:\Windows\System32\drivers\etc\hosts", "Hosts file"),
    (r"C:\Windows\System32\drivers\etc\lmhosts.sam", "LMHOSTS (sample)"),
    (r"C:\Windows\System32\drivers\etc\networks", "Networks"),
    (r"C:\Windows\System32\drivers\etc\protocol", "Protocols"),
    (r"C:\Windows\System32\drivers\etc\services", "Services (ports)"),
]
_HOSTS_FILE = r"C:\Windows\System32\drivers\etc\hosts"


def _win_netfiles():
    lines = []
    for path, _label in _WIN_CONFIG_FILES:
        if os.path.exists(path):
            lines.append("FILE:" + path)
    if not lines:                       # hosts always exists — safety net
        lines.append("FILE:" + _HOSTS_FILE)
    lines.append("UNIT:Dnscache")       # restart target: flush DNS after hosts edit
    return "\n".join(lines)


def _b64d(s):
    try:
        return base64.b64decode(s or "").decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return ""


def _job_result(url, token, job_id, data_b64=None, error=None):
    body = {"token": token, "id": job_id}
    if error is not None:
        body["error"] = str(error)
    else:
        body["data_b64"] = data_b64 or ""
    try:
        _post(url + "/agents/fs-result", body)
    except Exception:  # noqa: BLE001
        pass


def _ps(script, timeout=30):
    """Run a PowerShell snippet (UTF-16LE -EncodedCommand) and return combined output."""
    b = base64.b64encode(script.encode("utf-16-le")).decode()
    try:
        p = _run_cmd(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", b],
                     timeout=timeout)
        out = p.stdout or ""
        if p.returncode != 0 and p.stderr:
            out += ("\n" + p.stderr)
        return out
    except Exception as e:  # noqa: BLE001
        return "ERR:%s" % e


def _win_norm(path):
    """Accept POSIX-ish ('/C:/x'), bare drive ('C:'), or native ('C:\\x') → native."""
    p = (path or "").strip().lstrip("/").replace("/", "\\")
    if len(p) == 2 and p[1] == ":":
        p += "\\"
    return p


def _ls_line(name, st, is_dir, is_link):
    perms = ("d" if is_dir else "l" if is_link else "-") + "rwxr-xr-x"
    try:
        lt = time.localtime(st.st_mtime if st else 0)
        date, tm = time.strftime("%Y-%m-%d", lt), time.strftime("%H:%M", lt)
    except Exception:  # noqa: BLE001
        date, tm = "1970-01-01", "00:00"
    size = st.st_size if st else 0
    return "%s 1 - - %s %s %s %s" % (perms, size, date, tm, name)


def _win_list(path):
    raw = (path or "/").strip()
    p = raw.lstrip("/").replace("/", "\\")
    if p == "":                                   # root → drive letters as folders
        lines = []
        try:
            import ctypes
            bm = ctypes.windll.kernel32.GetLogicalDrives()
        except Exception:  # noqa: BLE001
            bm = 0
        import string
        for i, letter in enumerate(string.ascii_uppercase):
            if bm & (1 << i):
                lines.append(_ls_line(letter + ":", None, True, False))
        return "\n".join(lines)
    if len(p) == 2 and p[1] == ":":
        p += "\\"
    out = []
    for name in os.listdir(p):
        full = os.path.join(p, name)
        try:
            stt = os.stat(full)
        except OSError:
            stt = None
        out.append(_ls_line(name, stt, os.path.isdir(full), os.path.islink(full)))
    return "\n".join(out)


def _win_read(path):
    p = _win_norm(path)
    try:
        sz = os.path.getsize(p)
    except OSError:
        sz = -1
    blob = b""
    if sz >= 0:
        try:
            with open(p, "rb") as f:
                blob = f.read(65536)
        except OSError:
            sz = -1
    return b"SIZE:" + str(sz).encode() + b"\n" + blob


def _win_write(path, data):
    p = _win_norm(path)
    try:
        if os.path.isfile(p):
            import shutil
            try:
                shutil.copy2(p, p + ".actmon.bak")
            except OSError:
                pass
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(data)
        return "OK:" + str(os.path.getsize(p))
    except Exception as e:  # noqa: BLE001
        return "ERR:" + str(e)


def _win_fwctl(arg):
    verb = arg.split(":", 1)[0] if arg else "list"
    if verb == "add":
        bits = (arg.split(":", 2) + ["", ""])[:3]
        action, ip = bits[1], bits[2]
        act = "Allow" if action == "allow" else "Block"
        name = "ActMon %s %s" % (action, ip)
        _ps('New-NetFirewallRule -DisplayName "%s" -Group ActMon -Direction Inbound '
            '-RemoteAddress "%s" -Action %s -Profile Any -ErrorAction SilentlyContinue | Out-Null'
            % (name, ip, act))
    elif verb == "del":
        name = arg.partition(":")[2]
        _ps('Remove-NetFirewallRule -DisplayName "%s" -ErrorAction SilentlyContinue' % name)
    return _ps(
        "Get-NetFirewallRule -Group ActMon -ErrorAction SilentlyContinue | ForEach-Object { "
        "$ip=($_ | Get-NetFirewallAddressFilter).RemoteAddress; "
        '"WINFW|$($_.DisplayName)|$($_.Action)|$ip" }')


def _win_svcctl(arg):
    verb = arg.split(":", 1)[0] if arg else "services"
    if verb in ("start", "stop", "restart"):
        u = arg.partition(":")[2]
        cmd = {"start": "Start-Service", "stop": "Stop-Service", "restart": "Restart-Service"}[verb]
        extra = " -Force" if verb in ("stop", "restart") else ""
        return _ps('try { %s -Name "%s"%s -ErrorAction Stop; '
                   '"OK:%sed %s; $((Get-Service -Name "%s").Status)" } '
                   'catch { "ERR:$($_.Exception.Message)" }' % (cmd, u, extra, verb, u, u))
    # full service inventory with status (name|Running/Stopped|display)
    return _ps("Get-Service | Select-Object -First 400 "
               '| ForEach-Object { "$($_.Name)|$($_.Status)|$($_.DisplayName)" }')


def _reg_ps_path(key):
    k = (key or "").strip()
    for a, b in (("HKEY_LOCAL_MACHINE\\", "HKLM:\\"), ("HKEY_CURRENT_USER\\", "HKCU:\\"),
                 ("HKEY_CLASSES_ROOT\\", "HKCR:\\"), ("HKEY_USERS\\", "HKU:\\"),
                 ("HKLM\\", "HKLM:\\"), ("HKCU\\", "HKCU:\\"), ("HKCR\\", "HKCR:\\"), ("HKU\\", "HKU:\\")):
        if k.upper().startswith(a):
            return b + k[len(a):]
    return k


def _win_regget(key):
    p = _reg_ps_path(key).replace("'", "''")
    return _ps("try { (Get-ItemProperty -Path '" + p + "' -ErrorAction Stop).PSObject.Properties | "
               "Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { \"$($_.Name)=$($_.Value)\" } } "
               "catch { \"ERR:$($_.Exception.Message)\" }")


def _win_regset(arg):
    parts = (arg or "").split("|", 2)
    if len(parts) < 3:
        return "ERR:bad args"
    p = _reg_ps_path(parts[0]).replace("'", "''")
    name = parts[1].replace("'", "''")
    value = parts[2].replace("'", "''")
    return _ps("try { Set-ItemProperty -Path '" + p + "' -Name '" + name + "' -Value '" + value + "' -ErrorAction Stop; "
               "'OK:set " + name + "' } catch { \"ERR:$($_.Exception.Message)\" }")


def _win_runcmd(cmd):
    try:
        r = _run_cmd(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd])
        out = r.stdout or ""
        if r.returncode != 0 and r.stderr:
            out += ("\n" + r.stderr)
        return out or "(no output)"
    except Exception as e:  # noqa: BLE001
        return "ERR:" + str(e)


def _self_update(url, token):
    """Download this deployment's token-baked MSI and launch a silent upgrade that
    keeps our identity (token/url are baked into the MSI). The upgrade stops+replaces
    +restarts our own service, so it's run from an independent SYSTEM scheduled task
    (falling back to a detached process) so it survives us being stopped."""
    import tempfile
    import datetime
    import urllib.parse
    try:
        msi_url = "%s/agents/install/actmon-agent.msi?token=%s&url=%s" % (
            (url or "").rstrip("/"), urllib.parse.quote(token or ""), urllib.parse.quote(url or ""))
        tmp = os.path.join(tempfile.gettempdir(), "actmon-agent-update.msi")
        urllib.request.urlretrieve(msi_url, tmp)
        if not os.path.isfile(tmp) or os.path.getsize(tmp) < 100000:
            return "ERR:downloaded MSI looks invalid"
        pd = os.environ.get("ProgramData") or r"C:\ProgramData"
        log = os.path.join(pd, "ActMon", "update.log")
        run = 'msiexec /i "%s" /qn /norestart /l*v "%s"' % (tmp, log)
        when = (datetime.datetime.now() + datetime.timedelta(minutes=1)).strftime("%H:%M")
        r = _run_cmd(["schtasks", "/Create", "/F", "/TN", "ActMonAgentUpdate",
                      "/SC", "ONCE", "/ST", when, "/RU", "SYSTEM", "/RL", "HIGHEST",
                      "/TR", run], timeout=30)
        if r.returncode == 0:
            return "OK:update scheduled - the agent will upgrade and reconnect within ~1-2 minutes"
        # Fallback: launch detached (0x8 DETACHED | 0x200 NEW_GROUP | 0x1000000 BREAKAWAY)
        subprocess.Popen(["msiexec", "/i", tmp, "/qn", "/norestart", "/l*v", log],
                         creationflags=0x08 | 0x200 | 0x01000000, close_fds=True)
        return "OK:upgrade launched - the agent will restart shortly"
    except Exception as e:  # noqa: BLE001
        return "ERR:" + str(e)


# ── DB connection reuse ────────────────────────────────────────────────────────
# A dashboard refresh issues ~20 queries. Opening a fresh connection for each
# (Oracle thin-mode connect is several seconds) made the panel so slow the server's
# per-query timeout tripped — poisoning the whole dashboard onto the (wrong) direct
# path. Keep one short-lived connection per target and reuse it. The agent runs jobs
# single-threaded, so the connection is never used concurrently; the lock only guards
# the dict (and future-proofs against a threaded caller).
_DBQ_CACHE = {}                 # (dbtype,host,port,user,db) -> {"cn": conn, "ts": epoch}
_DBQ_LOCK = threading.Lock()
_DBQ_IDLE = 300                 # close a connection left unused this many seconds


def _dbq_open(dbtype, host, port, user, pw, dbname):
    """Open a new DB connection for the engine. Lenient db_type — accepts canonical
    ids AND display names ('SQL Server', 'Oracle DB', 'MariaDB', 'Postgres', …).
    Raises on failure (message preserved so the server can decide on a fallback)."""
    if "mysql" in dbtype or "maria" in dbtype:
        import pymysql
        return pymysql.connect(host=host, port=port or 3306, user=user, password=pw,
                               database=dbname, connect_timeout=10, read_timeout=25)
    if "postgre" in dbtype or "postgres" in dbtype or dbtype == "pg":
        import psycopg2
        return psycopg2.connect(host=host, port=port or 5432, user=user, password=pw,
                                dbname=dbname or "postgres", connect_timeout=10)
    if "mssql" in dbtype or "sql server" in dbtype or "sqlserver" in dbtype:
        import pymssql
        return pymssql.connect(server=host, port=str(port or 1433), user=user, password=pw,
                               database=dbname or "master", login_timeout=10, timeout=25)
    if "oracle" in dbtype:
        import oracledb
        _ora_init_thick(oracledb)
        svc = dbname or "XE"
        return oracledb.connect(user=user, password=pw, dsn="%s:%s/%s" % (host, port or 1521, svc))
    if "clickhouse" in dbtype:
        # DBAPI wrapper of the native-protocol driver — cursor semantics match the
        # generic SQL path below (execute/description/fetchall). The DBAPI connect is
        # LAZY, so probe now: a bad host/port/credential must fail HERE (clean
        # "connect failed: …"), not on the first real query.
        from clickhouse_driver import dbapi as _chdbapi
        cn = _chdbapi.connect(host=host, port=port or 9000, user=user or "default",
                              password=pw, database=dbname or "default",
                              connect_timeout=10)
        probe = cn.cursor()
        probe.execute("SELECT 1")
        probe.fetchall()
        return cn
    if "mongo" in dbtype:
        import pymongo
        auth = ""
        if user:
            try:
                from urllib.parse import quote_plus as _qp
            except ImportError:          # pragma: no cover — py2 never reaches here
                _qp = lambda s: s  # noqa: E731
            auth = "%s:%s@" % (_qp(user), _qp(pw or ""))
        uri = "mongodb://%s%s:%s/" % (auth, host, port or 27017)
        cli = pymongo.MongoClient(uri, serverSelectionTimeoutMS=4000, connectTimeoutMS=4000)
        cli.admin.command("ping")        # force the connection NOW (raises on failure)
        return cli
    raise ValueError("unsupported db_type '%s'" % dbtype)


# python-oracledb THIN mode (pure python) mishandles the connection hand-off used by
# Grid/ASM listeners on older Pythons — connects die with [Errno 9]/[Errno 107] even
# locally. DB servers always carry the real Oracle client libraries, and THICK mode
# negotiates the hand-off natively. Auto-detect the libs once and switch; if none are
# found (plain hosts, XE, laptops), thin mode stays — no behaviour change there.
_ORA_THICK = None   # None = not tried | str = lib dir in use | False = staying thin


def _ora_init_thick(oracledb):
    global _ORA_THICK
    if _ORA_THICK is not None:
        return
    import glob
    cands = []
    env_dir = os.environ.get("ACTMON_ORACLE_LIB")   # explicit override, wins
    if env_dir:
        cands.append(env_dir)
    for pat in ("/u01/app/oracle/product/*/db*/lib", "/u01/app/*/grid/lib",
                "/opt/oracle/product/*/db*/lib", "/opt/oracle/instantclient*",
                "/usr/lib/oracle/*/client*/lib"):
        cands.extend(sorted(glob.glob(pat), reverse=True))
    for d in cands:
        if not d or not os.path.isdir(d) or not glob.glob(os.path.join(d, "libclntsh.so*")):
            continue
        try:
            oracledb.init_oracle_client(lib_dir=d)
            _ORA_THICK = d
            _log("oracledb: thick mode enabled (client libs: %s)" % d)
            return
        except Exception as e:  # noqa: BLE001 — try the next candidate
            _log("oracledb: thick init via %s failed: %s" % (d, str(e)[:120]))
    _ORA_THICK = False


def _dbq_get_conn(key, dbtype, host, port, user, pw, dbname):
    """Return (connection, reused). Reuses a fresh cached connection; otherwise opens a
    new one (closing any stale entry first). Raises on connect failure."""
    now = time.time()
    stale = None
    with _DBQ_LOCK:
        ent = _DBQ_CACHE.get(key)
        if ent and (now - ent["ts"]) < _DBQ_IDLE:
            ent["ts"] = now
            return ent["cn"], True
        stale = ent
        if stale:
            _DBQ_CACHE.pop(key, None)
    if stale:
        try: stale["cn"].close()
        except Exception: pass  # noqa: BLE001
    cn = _dbq_open(dbtype, host, port, user, pw, dbname)
    with _DBQ_LOCK:
        _DBQ_CACHE[key] = {"cn": cn, "ts": now}
    return cn, False


def _dbq_drop(key):
    with _DBQ_LOCK:
        ent = _DBQ_CACHE.pop(key, None)
    if ent:
        try: ent["cn"].close()
        except Exception: pass  # noqa: BLE001


def _dbquery(arg):
    """Run a read query against a DB on THIS host. Because the agent runs where the
    database lives, a 'localhost' connection resolves correctly (unlike the backend).
    Reuses a cached connection across queries. Returns JSON {columns, rows} or {error}."""
    try:
        req = json.loads(arg)
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": "bad request: %s" % e})
    dbtype = (req.get("db_type") or "").lower().strip()
    host = req.get("host") or "127.0.0.1"
    if host.lower() in ("localhost", "::1"):
        host = "127.0.0.1"
    port = int(req.get("port") or 0)
    user = req.get("user") or ""
    pw = req.get("password") or ""
    dbname = req.get("database") or None
    sql = req.get("sql") or ""
    key = (dbtype, host, port, user, dbname)

    def _run_mongo(cli):
        # MongoDB is command-based, not SQL. The 'sql' field carries either a JSON
        # command document (e.g. '{"serverStatus": 1}') or a bare name ('ping').
        # The result is one row, one column: the command's JSON response.
        s = (sql or "").strip()
        cmd = None
        if s.startswith("{"):
            try:
                cmd = json.loads(s)
            except Exception:  # noqa: BLE001
                cmd = None
        if cmd is None:
            name = s.split()[0].lower() if s else "ping"
            cmd = {"ping": 1} if name in ("select", "ping", "1", "") else {name: 1}
        dbobj = cli[dbname] if dbname else cli.admin
        res = dbobj.command(cmd)
        return json.dumps({"columns": ["result"], "rows": [[json.dumps(res, default=str)]]})

    def _run(cn):
        if "mongo" in dbtype:
            return _run_mongo(cn)
        cur = cn.cursor()
        cur.execute(sql)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchall() if cur.description else []
        try:
            cn.commit()   # persist writes/DDL (e.g. CREATE EXTENSION); harmless for reads
        except Exception:  # noqa: BLE001
            pass
        return json.dumps({"columns": list(cols), "rows": [list(r) for r in rows]}, default=str)

    try:
        cn, reused = _dbq_get_conn(key, dbtype, host, port, user, pw, dbname)
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": "connect failed: %s" % e})
    try:
        return _run(cn)
    except Exception as e:  # noqa: BLE001
        # A reused connection may have been dropped by the DB (idle timeout) — retry
        # once with a fresh one before giving up.
        if reused:
            _dbq_drop(key)
            try:
                cn, _ = _dbq_get_conn(key, dbtype, host, port, user, pw, dbname)
                return _run(cn)
            except Exception as e2:  # noqa: BLE001
                _dbq_drop(key)
                return json.dumps({"error": "query failed: %s" % e2})
        _dbq_drop(key)
        return json.dumps({"error": "query failed: %s" % e})


def _win_diag(arg):
    kind = arg.split(":", 1)[0]
    rest = arg.partition(":")[2]
    if kind == "ping":
        return _ps("ping -n 4 " + rest)
    if kind == "port":
        host, _, port = rest.rpartition(":")
        return _ps('Test-NetConnection -ComputerName "%s" -Port %s -WarningAction SilentlyContinue '
                   '| Select-Object ComputerName,RemoteAddress,RemotePort,TcpTestSucceeded,PingSucceeded '
                   '| Format-List | Out-String' % (host, port))
    if kind == "dns":
        return _ps('try { Resolve-DnsName -Name "%s" -ErrorAction Stop | Format-Table -AutoSize | Out-String } '
                   'catch { nslookup "%s" 2>&1 | Out-String }' % (rest, rest))
    return "unsupported diag: " + kind


# ── Cross-platform shell + file transfer (used by the Backup & Restore module) ──
# The backend routes pg_dump/pg_restore/mysqldump etc. THROUGH the agent for
# agent-linked (localhost) databases the server cannot reach over the network.

def _shell(cmd, stdin_bytes=None, timeout=3600):
    """Run a shell command on this host. Returns (exit_code, stdout_bytes, stderr_text).
    Linux -> bash -c ; Windows -> cmd /c. stdout is captured as raw BYTES so binary
    dump output survives; stderr is decoded text."""
    args = ["cmd", "/c", cmd] if IS_WINDOWS else ["bash", "-c", cmd]
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         stdin=subprocess.PIPE if stdin_bytes is not None else None)
    out, err = p.communicate(input=stdin_bytes, timeout=timeout)
    return p.returncode, (out or b""), (err or b"").decode("utf-8", "replace")


def _op_shell(cmd):
    """Return a text envelope: EXIT:<code> then stdout then stderr. For CONTROL commands
    whose stdout is text (pg_dump-to-file, psql restore, checks, rm/mkdir)."""
    code, out, err = _shell(cmd)
    body = "EXIT:%d\n" % code
    body += out.decode("utf-8", "replace")
    if err:
        body += "\n--STDERR--\n" + err
    return body.encode("utf-8", "replace")


def _op_getfile(path):
    """Read a file on this host and return its raw bytes (base64-wrapped by the channel)."""
    with open(path, "rb") as f:
        return f.read()


def _op_putfile(path, data_b64):
    """Write base64 payload to a file on this host (used to upload a dump before restore)."""
    raw = base64.b64decode(data_b64 or "")
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with open(path, "wb") as f:
        f.write(raw)
    return ("OK:wrote %d bytes to %s" % (len(raw), path)).encode("utf-8")


_CROSS_PLATFORM_OPS = ("dbquery", "shell", "getfile", "putfile")   # safe on the Linux Python agent


def _handle_job(url, token, job_id, op, path, data):
    try:
        if not IS_WINDOWS and op not in _CROSS_PLATFORM_OPS:
            out = ("ERR:op '%s' is not supported on the Linux agent yet "
                   "(host metrics + database monitoring are)." % op).encode("utf-8")
            _job_result(url, token, job_id, base64.b64encode(out).decode())
            return
        if op == "list":
            out = _win_list(path).encode("utf-8", "replace")
        elif op == "read":
            out = _win_read(path)
        elif op == "write":
            out = _win_write(path, data).encode("utf-8", "replace")
        elif op == "netfiles":
            out = _win_netfiles().encode("utf-8")
        elif op == "netcfg":
            out = _ps("Get-NetIPConfiguration | Out-String").encode("utf-8", "replace")
        elif op == "fwctl":
            out = _win_fwctl(path).encode("utf-8", "replace")
        elif op == "diag":
            out = _win_diag(path).encode("utf-8", "replace")
        elif op == "regget":
            out = _win_regget(path).encode("utf-8", "replace")
        elif op == "regset":
            out = _win_regset(path).encode("utf-8", "replace")
        elif op == "runcmd":
            out = _win_runcmd(path).encode("utf-8", "replace")
        elif op == "dbquery":
            out = _dbquery(path).encode("utf-8", "replace")
        elif op == "shell":
            out = _op_shell(path)
        elif op == "getfile":
            out = _op_getfile(path)
        elif op == "putfile":
            out = _op_putfile(path, data)
        elif op == "selfupdate":
            out = _self_update(url, token).encode("utf-8", "replace")
        elif op == "killproc":
            pid = "".join(ch for ch in (path or "") if ch.isdigit())
            if not pid:
                out = b"ERR:invalid pid"
            else:
                r = _ps('try { Stop-Process -Id %s -Force -ErrorAction Stop; "OK:killed %s" } '
                        'catch { "ERR:$($_.Exception.Message)" }' % (pid, pid))
                out = r.encode("utf-8", "replace")
        elif op == "svcctl":
            if (path or "").split(":", 1)[0] == "reboot":
                _job_result(url, token, job_id, base64.b64encode(b"OK:rebooting").decode())
                try:
                    subprocess.Popen(["shutdown", "/r", "/t", "5"])
                except Exception:  # noqa: BLE001
                    pass
                return
            out = _win_svcctl(path).encode("utf-8", "replace")
        else:
            out = ("unsupported op: %s" % op).encode("utf-8")
        _job_result(url, token, job_id, base64.b64encode(out).decode())
    except Exception as e:  # noqa: BLE001
        _job_result(url, token, job_id, error=e)


# ── Linux self-update ──────────────────────────────────────────────────────────
# The fleet drifted because every agent improvement needed a manual reinstall on
# every host. Linux agents now check the server hourly: if the served source hash
# differs from the running file, they download it (checksum-verified), swap the
# file atomically and exit(0) — systemd's Restart=always relaunches the new code.
# Windows agents are a bundled exe (updated via the installer), so they skip this.

_SELFUPDATE_SEC = int(os.environ.get("ACTMON_SELFUPDATE_SEC", "3600") or 3600)
_last_selfupdate_check = [0.0]


def _self_update_check(url):
    if IS_WINDOWS or _SELFUPDATE_SEC <= 0:
        return
    now = time.time()
    if (now - _last_selfupdate_check[0]) < _SELFUPDATE_SEC:
        return
    _last_selfupdate_check[0] = now
    try:
        me = os.path.abspath(__file__)
        if not me.startswith("/usr/lib/actmon"):
            return                          # dev / non-packaged runs never self-update
        import hashlib
        with open(me, "rb") as f:
            my_sha = hashlib.sha256(f.read().replace(b"\r\n", b"\n")).hexdigest()
        info = _get_json(url + "/agents/agent-source/sha")
        srv_sha = (info or {}).get("sha") or ""
        if not srv_sha or srv_sha == my_sha:
            return
        src = _get_text(url + "/agents/agent-source", timeout=30)
        if hashlib.sha256(src.encode("utf-8")).hexdigest() != srv_sha:
            _log("self-update: checksum mismatch - skipped")
            return
        tmp = me + ".new"
        with open(tmp, "w") as f:
            f.write(src)
        os.replace(tmp, me)                 # atomic swap
        _log("self-update: new agent version installed - restarting")
        sys.exit(0)                         # systemd Restart=always relaunches us
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _log("self-update check failed: %s" % e)


def _poll_jobs_until(url, token, until_ts, stop_event=None):
    """Answer host jobs until the next infra push is due (spends the idle window)."""
    while time.time() < until_ts and not (stop_event is not None and stop_event.is_set()):
        try:
            jobs = _get_text("%s/agents/fs-poll?token=%s&hold=12" % (url, token), timeout=20)
        except Exception:  # noqa: BLE001
            time.sleep(1)
            continue
        if not jobs.strip():
            continue
        for line in jobs.splitlines():
            parts = line.split("|")
            if len(parts) < 2 or not parts[0]:
                continue
            job_id, op = parts[0], parts[1]
            jp = _b64d(parts[2]) if len(parts) > 2 else ""
            jd = _b64d(parts[3]) if len(parts) > 3 else ""
            _handle_job(url, token, job_id, op, jp, jd)


def collect_mysql(tgt, state):
    """Connect to the local MySQL and collect internals (status + top SQL).
    Returns (metrics dict, top_sql list) matching the backend ingest shape."""
    import pymysql
    conn = pymysql.connect(
        host=tgt.get("host") or "localhost", port=int(tgt.get("port") or 3306),
        user=tgt.get("username"), password=tgt.get("password") or "",
        database=tgt.get("database") or None, connect_timeout=6, read_timeout=10,
    )
    try:
        cur = conn.cursor()
        cur.execute("SHOW GLOBAL STATUS")
        st = {k: v for (k, v) in cur.fetchall()}
        cur.execute("SHOW GLOBAL VARIABLES LIKE 'max_connections'")
        row = cur.fetchall()
        max_conn = int(row[0][1]) if row else 0

        def g(k):
            try:
                return float(st.get(k, 0) or 0)
            except (TypeError, ValueError):
                return 0.0

        uptime = g("Uptime") or 1.0
        queries, commits, rollbacks = g("Queries"), g("Com_commit"), g("Com_rollback")
        now = time.time()
        qps = tps = 0.0
        if state.get("t"):
            dt = max(1.0, now - state["t"])
            qps = max(0.0, (queries - state["q"]) / dt)
            tps = max(0.0, ((commits + rollbacks) - state["tx"]) / dt)
        state.update(t=now, q=queries, tx=commits + rollbacks)

        rr, rd = g("Innodb_buffer_pool_read_requests"), g("Innodb_buffer_pool_reads")
        cache = 100.0 if rr <= 0 else max(0.0, (1 - rd / rr) * 100)

        metrics = {
            "host_cpu": 0.0, "host_memory": 0.0, "db_cpu": 0.0,
            "active_sessions": int(g("Threads_running")),
            "connections_used": int(g("Threads_connected")),
            "connections_max": max_conn,
            "cache_hit_pct": round(cache, 1),
            "qps": round(qps, 1), "tps": round(tps, 1),
            "uptime_seconds": int(uptime),
        }

        top = []
        try:
            cur.execute(
                "SELECT DIGEST, LEFT(DIGEST_TEXT,500), COUNT_STAR, SUM_TIMER_WAIT, "
                "AVG_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT "
                "FROM performance_schema.events_statements_summary_by_digest "
                "WHERE DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 20")
            for dig, txt, cnt, sumt, avgt, rex, rsent in cur.fetchall():
                top.append({
                    "sql_id": (dig or "")[:64], "sql_text": txt or "",
                    "executions": int(cnt or 0),
                    "avg_elapsed_ms": float(avgt or 0) / 1e9,   # ps → ms
                    "total_ms": float(sumt or 0) / 1e9,
                    "rows_examined": float(rex or 0), "rows_sent": float(rsent or 0),
                })
        except Exception:  # noqa: BLE001 — performance_schema may be off
            pass

        sessions = []
        try:
            # Exclude the agent's own connection so counts reflect real client sessions.
            cur.execute(
                "SELECT ID,USER,HOST,DB,COMMAND,TIME,STATE,INFO FROM information_schema.PROCESSLIST "
                "WHERE ID <> CONNECTION_ID()")
            for row in cur.fetchall():
                sessions.append({
                    "session_id": str(row[0]), "username": row[1] or "", "client_host": row[2] or "",
                    "db_name": row[3] or "", "command": row[4] or "", "duration_ms": float(row[5] or 0) * 1000,
                    "state": row[6] or "", "query": (row[7] or "")[:1000],
                })
        except Exception:  # noqa: BLE001
            pass
        # Make the metric agree with the list: active = sessions actually running a query.
        metrics["active_sessions"] = sum(1 for s in sessions if (s["command"] or "").lower() == "query")
        metrics["connections_used"] = len(sessions) or metrics["connections_used"]
        return metrics, top, sessions
    finally:
        conn.close()


def collect_postgres(tgt, state):
    """Connect to the local PostgreSQL and collect internals (activity + top SQL)."""
    import psycopg2
    conn = psycopg2.connect(
        host=tgt.get("host") or "localhost", port=int(tgt.get("port") or 5432),
        user=tgt.get("username"), password=tgt.get("password") or "",
        dbname=tgt.get("database") or "postgres", connect_timeout=6,
    )
    try:
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM pg_stat_activity")
        used = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM pg_stat_activity WHERE state = 'active'")
        active = cur.fetchone()[0]
        cur.execute("SHOW max_connections")
        max_conn = int(cur.fetchone()[0])
        cur.execute("SELECT COALESCE(sum(xact_commit+xact_rollback),0), COALESCE(sum(blks_hit),0), COALESCE(sum(blks_read),0) FROM pg_stat_database")
        row = cur.fetchone()
        tx = float(row[0] or 0); hit = float(row[1] or 0); read = float(row[2] or 0)   # sum() → Decimal
        cache = 100.0 if (hit + read) <= 0 else (hit / (hit + read) * 100)

        now = time.time()
        qps = tps = 0.0
        calls = 0.0
        try:
            cur.execute("SELECT COALESCE(sum(calls),0) FROM pg_stat_statements")
            calls = float(cur.fetchone()[0] or 0)
        except Exception:
            conn.rollback()
        if state.get("t"):
            dt = max(1.0, now - state["t"])
            tps = max(0.0, (tx - state["tx"]) / dt)
            qps = max(0.0, (calls - state["calls"]) / dt) if calls else 0.0
        state.update(t=now, tx=tx, calls=calls)

        metrics = {
            "host_cpu": 0.0, "host_memory": 0.0, "db_cpu": 0.0,
            "active_sessions": int(active), "connections_used": int(used),
            "connections_max": max_conn, "cache_hit_pct": round(cache, 1),
            "qps": round(qps, 1), "tps": round(tps, 1), "uptime_seconds": 0,
        }
        top = []
        try:
            cur.execute(
                "SELECT queryid, LEFT(query,500), calls, total_exec_time, mean_exec_time, rows "
                "FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20")
            for qid, q, cnt, tot, mean, rows in cur.fetchall():
                top.append({
                    "sql_id": str(qid or "")[:64], "sql_text": q or "",
                    "executions": int(cnt or 0), "avg_elapsed_ms": float(mean or 0),
                    "total_ms": float(tot or 0), "rows_examined": float(rows or 0), "rows_sent": float(rows or 0),
                })
        except Exception:
            conn.rollback()   # pg_stat_statements not installed

        sessions = []
        try:
            cur.execute(
                "SELECT pid, usename, datname, client_addr, state, "
                "COALESCE(EXTRACT(EPOCH FROM (now()-query_start))*1000,0), LEFT(query,1000) "
                "FROM pg_stat_activity WHERE pid <> pg_backend_pid()")
            for pid, usr, dat, caddr, state, dur, q in cur.fetchall():
                sessions.append({
                    "session_id": str(pid), "username": usr or "", "db_name": dat or "",
                    "client_host": str(caddr or "local"), "state": state or "", "command": "",
                    "duration_ms": float(dur or 0), "query": (q or "")[:1000],
                })
        except Exception:
            conn.rollback()
        # Make the metric agree with the list: active = sessions in 'active' state.
        metrics["active_sessions"] = sum(1 for s in sessions if (s["state"] or "").lower() == "active")
        metrics["connections_used"] = len(sessions) or metrics["connections_used"]
        return metrics, top, sessions
    finally:
        conn.close()


def collect_mssql(tgt, state):
    """Connect to the local SQL Server and collect internals (DMVs + top SQL)."""
    import pymssql
    conn = pymssql.connect(
        server=tgt.get("host") or "localhost", port=int(tgt.get("port") or 1433),
        user=tgt.get("username"), password=tgt.get("password") or "",
        database=tgt.get("database") or "master", login_timeout=6, timeout=10,
    )
    try:
        cur = conn.cursor()
        cur.execute("SELECT DATEDIFF(SECOND, sqlserver_start_time, GETDATE()) FROM sys.dm_os_sys_info")
        uptime = int(cur.fetchone()[0] or 0)
        cur.execute("SELECT @@MAX_CONNECTIONS")
        max_conn = int(cur.fetchone()[0] or 0)

        # Cumulative perf counters → per-second rates via deltas between cycles.
        cur.execute(
            "SELECT RTRIM(counter_name), cntr_value FROM sys.dm_os_performance_counters "
            "WHERE (counter_name = 'Batch Requests/sec' AND object_name LIKE '%SQL Statistics%') "
            "   OR (counter_name = 'Transactions/sec' AND instance_name = '_Total')")
        ctr = {name: float(v or 0) for name, v in cur.fetchall()}
        batches, tx = ctr.get("Batch Requests/sec", 0.0), ctr.get("Transactions/sec", 0.0)
        now = time.time()
        qps = tps = 0.0
        if state.get("t"):
            dt = max(1.0, now - state["t"])
            qps = max(0.0, (batches - state["q"]) / dt)
            tps = max(0.0, (tx - state["tx"]) / dt)
        state.update(t=now, q=batches, tx=tx)

        cur.execute(
            "SELECT (a.cntr_value * 1.0 / NULLIF(b.cntr_value, 0)) * 100 "
            "FROM sys.dm_os_performance_counters a "
            "JOIN sys.dm_os_performance_counters b "
            "  ON b.counter_name = 'Buffer cache hit ratio base' AND b.object_name = a.object_name "
            "WHERE a.counter_name = 'Buffer cache hit ratio'")
        row = cur.fetchone()
        cache = float(row[0] or 0) if row else 0.0

        metrics = {
            "host_cpu": 0.0, "host_memory": 0.0, "db_cpu": 0.0,
            "active_sessions": 0, "connections_used": 0,
            "connections_max": max_conn, "cache_hit_pct": round(cache, 1),
            "qps": round(qps, 1), "tps": round(tps, 1), "uptime_seconds": uptime,
        }

        top = []
        try:
            cur.execute(
                "SELECT TOP 20 CONVERT(VARCHAR(64), qs.query_hash, 1), "
                "LEFT(SUBSTRING(st.text, (qs.statement_start_offset/2)+1, "
                "  ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) "
                "    ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1), 500), "
                "qs.execution_count, qs.total_elapsed_time/1000.0, "
                "(qs.total_elapsed_time / NULLIF(qs.execution_count,0))/1000.0, "
                "qs.total_logical_reads, ISNULL(qs.total_rows,0) "
                "FROM sys.dm_exec_query_stats qs "
                "CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st "
                "ORDER BY qs.total_elapsed_time DESC")
            for sid, txt, cnt, tot, avg, reads, rows in cur.fetchall():
                top.append({
                    "sql_id": (sid or "")[:64], "sql_text": txt or "",
                    "executions": int(cnt or 0), "avg_elapsed_ms": float(avg or 0),
                    "total_ms": float(tot or 0),
                    "rows_examined": float(reads or 0), "rows_sent": float(rows or 0),
                })
        except Exception:  # noqa: BLE001 — needs VIEW SERVER STATE
            pass

        sessions = []
        try:
            cur.execute(
                "SELECT s.session_id, s.login_name, ISNULL(s.host_name,''), "
                "ISNULL(DB_NAME(s.database_id),''), s.status, ISNULL(r.status,''), "
                "ISNULL(r.total_elapsed_time,0), ISNULL(t.text,'') "
                "FROM sys.dm_exec_sessions s "
                "LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id "
                "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t "
                "WHERE s.is_user_process = 1 AND s.session_id <> @@SPID")
            for sid, usr, hostn, dbn, sstat, rstat, dur, q in cur.fetchall():
                sessions.append({
                    "session_id": str(sid), "username": usr or "", "client_host": hostn or "",
                    "db_name": dbn or "", "command": rstat or "", "duration_ms": float(dur or 0),
                    "state": (rstat or sstat or ""), "query": (q or "")[:1000],
                })
        except Exception:  # noqa: BLE001
            pass
        # Make the metric agree with the list: active = sessions with a live request.
        metrics["active_sessions"] = sum(1 for s in sessions if (s["command"] or "").lower() in ("running", "runnable", "suspended"))
        metrics["connections_used"] = len(sessions) or metrics["connections_used"]
        return metrics, top, sessions
    finally:
        conn.close()


def run_agent(stop_event=None):
    """The monitoring loop. Runs from the Windows Service, a scheduled task, or the
    command line. `stop_event` (threading.Event) lets the service stop it cleanly."""
    def _stopping():
        return bool(stop_event is not None and stop_event.is_set())

    token, url = _resolve_config()
    if not token or not url:
        _log("ERROR: token/URL not configured (registry, --args, or env).")
        return 1

    # 15s default feeds the Redis hot tier at its designed cadence (override with
    # ACTMON_INTERVAL in /etc/actmon/agent.conf or the service environment).
    interval = int(os.environ.get("ACTMON_INTERVAL", "15") or 15)
    host = socket.gethostname()
    os_type = "windows" if IS_WINDOWS else "linux"
    collect_host = collect_windows if IS_WINDOWS else collect_linux
    collector_url = "%s/agents/collector/%s" % (url, os_type)
    _log("ActMon Agent starting on %s (%s) -> %s" % (host, os_type, url))

    # Fetch the exact collector command the backend expects (no drift vs SSH).
    collector = None
    while collector is None and not _stopping():
        try:
            collector = _get_text(collector_url)
        except Exception as e:  # noqa: BLE001
            _log("cannot reach backend (%s); retry in 10s" % e)
            for _ in range(10):
                if _stopping():
                    return 0
                time.sleep(1)
    if _stopping():
        return 0

    # Identity for DB metric pushes (enroll returns the agent name for this token).
    agent_name = None
    db_state = {}

    while not _stopping():
        # Self-update (Linux): hourly hash check against the server — keeps the whole
        # fleet current without manual reinstalls.
        _self_update_check(url)

        # Refresh the collector each cycle so backend collector changes (e.g. metric
        # fixes) apply to already-running agents WITHOUT a reinstall or restart.
        try:
            fresh = _get_text(collector_url)
            if fresh and fresh.strip():
                collector = fresh
        except Exception:  # noqa: BLE001 — keep the cached collector on a transient failure
            pass

        # 1) Host infra (always). The response tells us this agent's name.
        try:
            raw = collect_host(collector)
            res = _post(url + "/agents/infra", {"token": token, "os_type": os_type, "raw": raw})
            agent_name = res.get("agent_name") or agent_name
            if res.get("status") == "success":
                _log("infra pushed -> %s / %s" % (res.get("server_id"), agent_name))
            else:
                _log("infra push rejected by server: %s" % res)
        except Exception as e:  # noqa: BLE001
            _log("infra push to %s/agents/infra FAILED - cannot reach server: %s" % (url, e))

        # 2) DB internals for any DBs the wizard assigned to this agent.
        try:
            targets = _get_json("%s/agents/db-config?token=%s" % (url, token))
        except Exception:  # noqa: BLE001
            targets = []
        if targets and agent_name:
            for tgt in targets:
                dbt = (tgt.get("db_type") or "").lower()
                key = "%s:%s:%s" % (dbt, tgt.get("host"), tgt.get("port"))
                stt = db_state.setdefault(key, {})
                try:
                    if dbt in ("mysql", "mariadb"):
                        metrics, top, sessions = collect_mysql(tgt, stt)
                    elif dbt in ("postgresql", "postgres"):
                        metrics, top, sessions = collect_postgres(tgt, stt)
                    elif dbt in ("mssql", "sql server", "sqlserver"):
                        metrics, top, sessions = collect_mssql(tgt, stt)
                    else:
                        continue   # MySQL / PostgreSQL / MSSQL implemented so far
                    _post(url + "/agents/data", {"agent_name": agent_name, "metrics": metrics,
                                                 "top_sql": top, "sessions": sessions})
                    _log("%s pushed: qps=%s sessions=%s conns=%s top=%s" % (dbt, metrics["qps"], metrics["active_sessions"], len(sessions), len(top)))
                except Exception as e:  # noqa: BLE001
                    _log("%s collect failed: %s" % (dbt, e))

        # Spend the wait window answering interactive host jobs (file edit / firewall /
        # services / reboot) instead of sleeping — same channel the Linux agent uses.
        _poll_jobs_until(url, token, time.time() + max(5, interval), stop_event)
    _log("ActMon Agent stopping.")
    return 0


def main():
    return run_agent()


# ── Windows Service wrapper (preferred install mode) ───────────────────────────
try:
    import win32serviceutil
    import win32service
    import win32event
    import servicemanager
    _HAS_PYWIN32 = True
except Exception:  # noqa: BLE001 — not on Windows / pywin32 absent → standalone only
    _HAS_PYWIN32 = False

if _HAS_PYWIN32:
    class ActMonService(win32serviceutil.ServiceFramework):
        _svc_name_ = "ActMonAgent"
        _svc_display_name_ = "ActMon Monitoring Agent"
        _svc_description_ = "Collects host metrics/inventory and reports them to the ActMon server."

        def __init__(self, args):
            win32serviceutil.ServiceFramework.__init__(self, args)
            self._wait = win32event.CreateEvent(None, 0, 0, None)
            self._stop = __import__("threading").Event()

        def SvcStop(self):
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            self._stop.set()
            win32event.SetEvent(self._wait)

        def SvcDoRun(self):
            try:
                servicemanager.LogInfoMsg("ActMon Agent service starting")
            except Exception:  # noqa: BLE001
                pass
            t = __import__("threading").Thread(target=run_agent, args=(self._stop,), daemon=True)
            t.start()
            win32event.WaitForSingleObject(self._wait, win32event.INFINITE)


def _entry():
    """Dispatch: service verbs -> pywin32; no args under SCM -> run as service;
    otherwise (scheduled task / manual / --token) -> run standalone in the foreground."""
    verbs = {"install", "update", "remove", "start", "stop", "restart", "status", "--startup"}
    if _HAS_PYWIN32 and len(sys.argv) > 1 and sys.argv[1] in verbs:
        win32serviceutil.HandleCommandLine(ActMonService)
        return 0
    if _HAS_PYWIN32 and len(sys.argv) == 1:
        try:
            servicemanager.Initialize()
            servicemanager.PrepareToHostSingle(ActMonService)
            servicemanager.StartServiceCtrlDispatcher()   # blocks while SCM controls us
            return 0
        except Exception as e:  # noqa: BLE001 — 1063 = not launched by SCM → standalone
            if getattr(e, "winerror", None) != 1063:
                _log("service dispatch fell back to standalone: %s" % e)
    return run_agent()


if __name__ == "__main__":
    sys.exit(_entry())
