# RAC topology layout check

The topology diagram's collision was a layout fault, not a styling one: the
interconnect's parts needed ~259px of unshrinkable width inside a 224px
column, so the row overflowed across both node cards. A build passes that;
a unit test on the component passes that; only geometry catches it.

This measures the real compiled CSS in headless Chrome at 1920, 1600, 1366,
1024, 820 and 390px and asserts what the eye would check:

* nothing overflows its box, no text is clipped
* every interconnect label stays inside the centre column
* the centre column touches neither card and stays within its 180–240px range
* both node cards are exactly equal width
* the rail spans exactly card edge to card edge
* the storage card is centred and clear of the connectors and the legend

## Running it

```bash
cd frontend && npx vite build          # the check reads dist/assets/*.css
cd src/pages/oracle/__layout__
node make_harness.mjs harness.html
node run.mjs
```

Exit code is non-zero on any failure.

The harness mirrors `RacTopology.jsx`'s markup for a two-node cluster. If that
component's structure changes, update `make_harness.mjs` to match — otherwise
the check is measuring a page that no longer exists.
