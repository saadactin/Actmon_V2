"""
On-demand details for ONE process (CPU Performance → Process Details drawer).

Collecting parent PID / executable / command line / cwd / CPU time / context switches / open files for every process
every cycle would be wasteful, so they are read live, only for the process someone opens:
  agent host   the host's own agent runs a read-only command (job channel "shell", gated by the agent's permissions)
  SSH host     ActMon's SSH session with the host's saved credentials
  RAC peer     no agent and no SSH from ActMon — reported as unavailable

Read-only: the commands only read /proc (Linux) or Win32_Process (Windows). The PID is an integer validated before
it is put in the command, so nothing user-supplied reaches a shell. Command lines can hold credentials, so they are
masked here and returned in full / with the open-file list only to callers with the Infrastructure "execute" right.
"""
import json
import re

PROC_TIMEOUT = 25
_SECRET_KV = re.compile(r"(?i)((?:--?|\b)(?:password|passwd|pwd|pass|secret|token|api[_-]?key|access[_-]?key|auth)[=: ]+)(\S+)")
_URL_CRED = re.compile(r"(?i)(\b[a-z][a-z0-9+.-]*://[^/\s:@]+:)([^@\s]+)(@)")
_ORA_CRED = re.compile(r"(?<![\w/])([A-Za-z][\w$#]*/)([^@\s/]+)(@)")   # sqlplus user/pass@tns


def mask_secrets(cmd):
    s = _SECRET_KV.sub(lambda m: m.group(1) + "******", cmd or "")
    s = _URL_CRED.sub(lambda m: m.group(1) + "******" + m.group(3), s)
    return _ORA_CRED.sub(lambda m: m.group(1) + "******" + m.group(3), s)


def linux_command(pid):
    p = int(pid)
    return (
        f"d=/proc/{p}; [ -d $d ] || {{ echo '@@GONE@@'; exit 0; }}; "
        "echo '@@STAT@@'; cat $d/stat 2>&1; "
        "echo '@@STATUS@@'; grep -E '^(Name|State|PPid|Threads|VmRSS|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):' $d/status 2>&1; "
        "echo '@@EXE@@'; readlink $d/exe 2>&1; "
        "echo '@@CWD@@'; readlink $d/cwd 2>&1; "
        "echo '@@CMD@@'; tr '\\0' ' ' < $d/cmdline 2>&1 | head -c 4000; echo; "
        "echo '@@FDN@@'; ls $d/fd 2>/dev/null | wc -l; "
        # target after "-> " (keeps "/path (deleted)" whole); sockets/pipes/anon inodes grouped by kind, not inode
        "echo '@@FD@@'; ls -l $d/fd 2>&1 | sed -n 's/.* -> //p' | sed -E 's/^(socket|pipe|anon_inode):.*/\\1/' | sort | uniq -c | sort -rn | head -150; "
        "echo '@@SYS@@'; getconf CLK_TCK; awk '/^btime/{print $2}' /proc/stat; nproc 2>/dev/null"
    )


def windows_command(pid):
    p = int(pid)
    ps = ("$p=Get-CimInstance Win32_Process -Filter 'ProcessId=%d' -ErrorAction SilentlyContinue;"
          "if(-not $p){'@@GONE@@';exit};"
          "$o=Get-Process -Id %d -ErrorAction SilentlyContinue;"
          "[pscustomobject]@{ppid=$p.ParentProcessId;exe=$p.ExecutablePath;cmd=$p.CommandLine;"
          "created=$(if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')});"
          "kernel_100ns=$p.KernelModeTime;user_100ns=$p.UserModeTime;handles=$p.HandleCount;threads=$p.ThreadCount;"
          "ws=$p.WorkingSetSize;owner=$(try{($p|Invoke-CimMethod -MethodName GetOwner -ErrorAction Stop).User}catch{$null});"
          "modules=$(try{@($o.Modules|Select-Object -First 60 -ExpandProperty FileName)}catch{@()})}|ConvertTo-Json -Compress") % (p, p)
    import base64
    return "powershell -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(ps.encode("utf-16-le")).decode()


def _sections(txt):
    out, cur = {}, None
    for ln in (txt or "").splitlines():
        m = re.match(r"^@@([A-Z]+)@@$", ln.strip())
        if m:
            cur = m.group(1)
            out.setdefault(cur, [])
            continue
        if cur:
            out[cur].append(ln)
    return out


def _denied(lines):
    j = " ".join(lines)
    return "Permission denied" in j or "No such file" in j


def parse_linux(txt, full):
    sec = _sections(txt)
    if "GONE" in sec:
        return {"exists": False}
    res = {"exists": True, "platform": "linux"}
    st = " ".join(sec.get("STAT") or [])
    m = re.match(r"^\d+ \((.*)\) (\S) (.*)$", st)
    tick, btime, ncpu = 100, None, None
    sysl = [x.strip() for x in sec.get("SYS") or [] if x.strip()]
    if sysl:
        tick = int(sysl[0]) if sysl[0].isdigit() else 100
        btime = int(sysl[1]) if len(sysl) > 1 and sysl[1].isdigit() else None
        ncpu = int(sysl[2]) if len(sysl) > 2 and sysl[2].isdigit() else None
    if m:
        f = m.group(3).split()      # f[0] = field 4 (ppid)
        res["ppid"] = int(f[0])
        utime, stime = int(f[10]), int(f[11])                       # fields 14, 15
        res["cpu_time_s"] = round((utime + stime) / tick, 2)
        res["cpu_user_s"], res["cpu_kernel_s"] = round(utime / tick, 2), round(stime / tick, 2)
        if btime is not None:
            res["start_time_epoch"] = btime + int(f[18]) / tick       # field 22: starttime in ticks since boot
        res["nice"] = int(f[15])                                     # field 19
    stmap = {}
    for ln in sec.get("STATUS") or []:
        k, _, v = ln.partition(":")
        stmap[k.strip()] = v.strip()
    res["state"] = stmap.get("State")
    res["threads"] = int(stmap["Threads"]) if stmap.get("Threads", "").isdigit() else None
    vc, nvc = stmap.get("voluntary_ctxt_switches"), stmap.get("nonvoluntary_ctxt_switches")
    if vc and vc.isdigit() and nvc and nvc.isdigit():
        res["ctx_voluntary"], res["ctx_involuntary"] = int(vc), int(nvc)
        res["context_switches"] = int(vc) + int(nvc)

    def one(name):
        lines = [x for x in sec.get(name) or [] if x.strip()]
        if not lines:
            return None, None
        if _denied(lines):
            return None, "Not readable — the collecting account lacks permission for this process"
        return lines[0].strip(), None

    res["exe"], res["exe_error"] = one("EXE")
    res["cwd"], res["cwd_error"] = one("CWD")
    cmd = " ".join(x for x in sec.get("CMD") or []).strip()
    if cmd and not _denied([cmd]):
        res["command_line"] = cmd if full else mask_secrets(cmd)
        res["command_masked"] = not full or res["command_line"] != cmd
    fdn = [x.strip() for x in sec.get("FDN") or [] if x.strip()]
    res["open_files_count"] = int(fdn[0]) if fdn and fdn[0].isdigit() else None
    if res["open_files_count"] == 0 and _denied(sec.get("FD") or []):
        res["open_files_count"], res["open_files_error"] = None, "Not readable — the collecting account lacks permission for this process"
    if full and not res.get("open_files_error"):
        files = []
        for ln in sec.get("FD") or []:
            mm = re.match(r"^\s*(\d+)\s+(.*)$", ln)
            if mm:
                files.append({"count": int(mm.group(1)), "target": mm.group(2)})
        res["open_files"] = files
    res["cpus"] = ncpu
    return res


def parse_windows(txt, full):
    if "@@GONE@@" in (txt or ""):
        return {"exists": False}
    i = (txt or "").find("{")
    if i < 0:
        return {"exists": True, "platform": "windows", "error": (txt or "").strip()[:300] or "No output"}
    d = json.loads(txt[i:])
    k, u = d.get("kernel_100ns") or 0, d.get("user_100ns") or 0
    res = {"exists": True, "platform": "windows", "ppid": d.get("ppid"), "exe": d.get("exe"),
           "cwd": None, "cwd_error": "Windows does not expose another process's working directory",
           "cpu_time_s": round((k + u) / 1e7, 2), "cpu_user_s": round(u / 1e7, 2), "cpu_kernel_s": round(k / 1e7, 2),
           "threads": d.get("threads"), "open_files_count": d.get("handles"), "open_files_label": "handles",
           "start_time_iso": d.get("created"), "owner": d.get("owner"),
           "context_switches": None, "context_switches_error": "Not exposed per process by Win32_Process"}
    cmd = d.get("cmd") or ""
    if cmd:
        res["command_line"] = cmd if full else mask_secrets(cmd)
        res["command_masked"] = not full or res["command_line"] != cmd
    if full:
        res["open_files"] = [{"count": 1, "target": m} for m in (d.get("modules") or [])]
        res["open_files_note"] = "Loaded modules (Windows has no per-process open-file list without extra tools)"
    return res


def run(server, pid, full):
    """Returns the parsed detail dict; raises RuntimeError with a readable reason when it cannot be read."""
    is_win = "win" in str(server.os_type or "").lower()
    cmd = windows_command(pid) if is_win else linux_command(pid)
    if server.collector == "agent" and server.agent_token:
        from app.services.agent import agent_fs_service
        try:
            raw = agent_fs_service.request(server.agent_token, "shell", cmd, timeout=PROC_TIMEOUT)
        except RuntimeError as exc:          # e.g. remote-command permission not granted to this agent
            raise RuntimeError(str(exc))
        if raw is None:
            raise RuntimeError("The agent on this host did not answer in time.")
        txt = raw.decode("utf-8", "replace")
        if txt.startswith("EXIT:"):
            txt = txt.partition("\n")[2]
        via = "agent"
    elif server.collector == "ssh" and server.ssh_username:
        import paramiko
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            ssh.connect(hostname=server.ip_address, port=server.ssh_port or 22, username=server.ssh_username,
                        password=server.ssh_password, timeout=10)
            _, out, _ = ssh.exec_command(cmd, timeout=PROC_TIMEOUT)
            txt = out.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"SSH to the host failed: {type(exc).__name__}")
        finally:
            ssh.close()
        via = "ssh"
    else:
        raise RuntimeError("This host is collected through another node's agent, so ActMon cannot query its processes directly.")
    res = parse_windows(txt, full) if is_win else parse_linux(txt, full)
    res["via"] = via
    res["full_access"] = bool(full)
    return res
