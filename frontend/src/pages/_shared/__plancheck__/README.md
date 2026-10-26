# Execution-plan canvas harness

`PlanCanvas` is interactive: zoom, pan, minimap, node selection, four detail
tabs. A build proves it compiles and a unit test proves the layout maths — but
neither proves the zoom button zooms, and neither would have caught the card
whose object name ran behind its metrics row. This drives the real component
in a real browser.

## Running it

```bash
cd frontend && npx vite --port 5199        # terminal 1
node src/pages/_shared/__plancheck__/drive.mjs   # terminal 2 — asserts, exits non-zero on failure
node src/pages/_shared/__plancheck__/shot.mjs out.png   # a screenshot to look at
```

Override `PLANCHECK_URL` or `CHROME_PATH` if your setup differs.

## What it asserts

Rendering: every step drawn, every edge drawn, no two nodes overlapping, no
card's content spilling out of it, the whole plan fitting the stage on load.

Controls: Zoom in / Zoom out / Fit / Reset / Centre each do what they say,
wheel zoom, drag-to-pan.

Data honesty: the stage states the figures are optimizer estimates; no node
claims an elapsed time (`v$sql_plan` has none); the Statistics tab names
`STATISTICS_LEVEL=ALL` / `gather_plan_statistics` as where actual figures
would come from.

The rows in `entry.jsx` are a fixture FOR THE HARNESS. `PlanCanvas` itself
ships no sample data and renders only what the API returns.
