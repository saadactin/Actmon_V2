# Query Analysis / Execution Plan harness

Both pages are driven by router state and an API call, so neither renders in a
unit test and neither is proved by a build. This mounts the real components
with `client.get`/`client.post` stubbed at the axios instance — the pages' own
request and render paths still run, against a known payload.

```bash
cd frontend && npx vite --port 5199                       # terminal 1
node src/pages/_shared/__qacheck__/drive.mjs              # asserts
QA_URL='http://localhost:5199/src/pages/_shared/__qacheck__/index.html?page=plan' \
  node src/pages/_shared/__qacheck__/shot.mjs out.png     # a screenshot
```

`?failplan=1` makes the plan call return an Oracle error, to check the pages
say so rather than showing zeros.

## What it asserts

Page 1: the five metric cards carry the row's real values; the three action
cards are present in the reference's order; "Analyse this query" sits above
Quick insights, which sits above Related information; the insight figures are
counted from the plan (3 scans, cost 98,037); a plan that fails shows the real
ORA- error and "Not available" rather than 0.

Page 2: every plan row is a node; a table scanned twice is ONE warning; the
selection is shared both ways between diagram and table; the table has the
reference's seven columns and no Time column, because `v$sql_plan` has no
per-step elapsed time; search narrows the rows; no sideways scroll at 1920,
1366 or 430px.

The plan in `entry.jsx` is a fixture for the harness. Neither page ships
sample data.
