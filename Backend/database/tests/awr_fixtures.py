"""Synthetic AWR HTML shaped like a real 19c report (same summary attributes,
column headings and per-cell units as the PRODCDB reports), small enough to
read. build_awr() lets a test change one figure or drop a whole section."""

SECTIONS = {
    "instance": """<table summary="This table displays database instance information">
<tr><th>DB Name</th><th>DB Id</th><th>Unique Name</th><th>Role</th><th>Edition</th><th>Release</th><th>RAC</th><th>CDB</th></tr>
<tr><td>TESTDB</td><td>{dbid}</td><td>TESTDB</td><td>PRIMARY</td><td>EE</td><td>19.0.0.0.0</td><td>NO</td><td>NO</td></tr></table>
<table summary="This table displays database instance information">
<tr><th>Instance</th><th>Inst Num</th><th>Startup Time</th></tr><tr><td>TESTDB</td><td>1</td><td>01-Mar-26 01:00</td></tr></table>""",
    "host": """<table summary="This table displays host information">
<tr><th>Host Name</th><th>Platform</th><th>CPUs</th><th>Cores</th><th>Sockets</th><th>Memory (GB)</th></tr>
<tr><td>dbhost</td><td>Linux x86 64-bit</td><td>{cpus}</td><td>8</td><td>1</td><td>256.00</td></tr></table>""",
    "snapshot": """<table summary="This table displays snapshot information">
<tr><th></th><th>Snap Id</th><th>Snap Time</th><th>Sessions</th><th>Cursors/Session</th></tr>
<tr><td>Begin Snap:</td><td>{snap1}</td><td>{begin} </td><td>500</td><td>10.0</td></tr>
<tr><td>End Snap:</td><td>{snap2}</td><td>{end}</td><td>520</td><td>10.0</td></tr>
<tr><td>Elapsed:</td><td></td><td>{elapsed} (mins)</td><td></td><td></td></tr>
<tr><td>DB Time:</td><td></td><td>{dbtime} (mins)</td><td></td><td></td></tr></table>""",
    "load": """<h2 class="awr">Report Summary</h2><table summary="This table displays load profile">
<tr><th></th><th>Per Second</th><th>Per Transaction</th></tr>
<tr><td>DB Time(s):</td><td>{aas}</td><td>0.1</td></tr>
<tr><td>DB CPU(s):</td><td>{dbcpu}</td><td>0.1</td></tr>
<tr><td>Logical read (blocks):</td><td>100,000.0</td><td>10.0</td></tr>
<tr><td>Physical read (blocks):</td><td>2,000.0</td><td>1.0</td></tr>
<tr><td>Hard parses (SQL):</td><td>{hard}</td><td>0.0</td></tr></table>""",
    "efficiency": """<table summary="This table displays instance efficiency percentages">
<tr><td>Buffer Nowait %:</td><td>99.99</td><td>Redo NoWait %:</td><td>100.00</td></tr>
<tr><td>Library Hit %:</td><td>99.50</td><td>Soft Parse %:</td><td>{soft}</td></tr></table>""",
    "top10": """<table summary="This table displays top 10 wait events by total wait time">
<tr><th>Event</th><th>Waits</th><th>Total Wait Time (sec)</th><th>Avg Wait</th><th>% DB time</th><th>Wait Class</th></tr>
<tr><td>DB CPU</td><td></td><td>10K</td><td></td><td>45.0</td><td></td></tr>
<tr><td>log file sync</td><td>100,000</td><td>{lfs_total}</td><td>{lfs}</td><td>{commit_pct}</td><td>Commit</td></tr>
<tr><td>db file sequential read</td><td>1,000,000</td><td>800.0</td><td>800.00us</td><td>8.0</td><td>User I/O</td></tr></table>""",
    "classes": """<table summary="This table displays foreground wait class statistics">
<tr><th>Wait Class</th><th>Waits</th><th>%Time -outs</th><th>Total Wait Time (s)</th><th>Avg wait</th><th>%DB time</th></tr>
<tr><td>DB CPU</td><td></td><td></td><td>10,000</td><td></td><td>45.00</td></tr>
<tr><td>Commit</td><td>100,000</td><td>0</td><td>7,000</td><td>{lfs}</td><td>{commit_pct}</td></tr>
<tr><td>User I/O</td><td>1,000,000</td><td>0</td><td>800</td><td>800.00us</td><td>8.00</td></tr></table>""",
    "os": """<table summary="This table displays operating systems statistics. For each statistic, actual value is displayed.">
<tr><th>Statistic</th><th>Value</th><th>End Value</th></tr>
<tr><td>BUSY_TIME</td><td>{busy}</td><td></td></tr><tr><td>IDLE_TIME</td><td>{idle}</td><td></td></tr>
<tr><td>LOAD</td><td>4</td><td>5</td></tr><tr><td>NUM_CPUS</td><td>{cpus}</td><td></td></tr></table>""",
    "sql": """<h3 class="awr">SQL ordered by Elapsed Time</h3>
<table><tr><th>Elapsed Time (s)</th><th>Executions</th><th>Elapsed Time per Exec (s)</th><th>%Total</th><th>%CPU</th><th>%IO</th><th>SQL Id</th><th>SQL Module</th><th>SQL Text</th></tr>
<tr><td>{sql_elapsed}</td><td>100</td><td>{sql_per_exec}</td><td>9.0</td><td>95.0</td><td>2.0</td><td>abc123def4567</td><td>batch:job1</td><td>SELECT * FROM big_table WHERE x = :1</td></tr>
<tr><td>30.00</td><td>10</td><td>3.00</td><td>0.5</td><td>50.0</td><td>40.0</td><td>zzz999yyy8887</td><td>app</td><td>UPDATE t SET y = 1</td></tr></table>""",
}

DEFAULTS = dict(dbid="1111111111", cpus=16, snap1=100, snap2=101, begin="01-Mar-26 09:00:00",
                end="01-Mar-26 10:00:00", elapsed="60.00", dbtime="600.00", aas="10.0", dbcpu="4.5",
                hard="2.0", soft="99.50", lfs="150.00ms", lfs_total="7.0K", commit_pct="35.0",
                busy="300,000", idle="700,000", sql_elapsed="3,240.00", sql_per_exec="32.40")


def build_awr(drop=(), **overrides) -> str:
    values = {**DEFAULTS, **overrides}
    body = "".join(html.format(**values) for name, html in SECTIONS.items() if name not in drop)
    header = "<h1>WORKLOAD REPOSITORY report for</h1>"
    window = (f"<p>Begin Snap: {values['snap1']} {values['begin']} End Snap: {values['snap2']} {values['end']} "
              f"Elapsed: {values['elapsed']} (mins) DB Time: {values['dbtime']} (mins)</p>")
    return f"<html><body class='awr'>{header}{window}{body}</body></html>"
