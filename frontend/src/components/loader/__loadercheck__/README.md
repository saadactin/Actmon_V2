# ACTMON loader harness

The loader's claims are behavioural, not visual: that the percentage tracks
real work, that time passing does not move it, that a failure shows the error
instead of a full bar, and that only subsystems actually being queried get a
panel. A build proves none of that. This drives the real component.

## Running it

```bash
cd frontend && npx vite --port 5199            # terminal 1
node src/components/loader/__loadercheck__/drive.mjs    # asserts; non-zero exit on failure
node src/components/loader/__loadercheck__/shot.mjs out.png
```

`CHROME_PATH` and `LOADER_URL` override the defaults. The driver runs Chrome
with SwiftShader so WebGL is genuinely available headless.

## What it asserts

* the loader covers the screen and the app behind it does not render
* boot shows exactly its two declared panels, and none it does not touch
* the percentage is the weight of finished work (25% = 1 of 1+3)
* **2.5 seconds of waiting does not move the bar** — the anti-timer check
* the app renders only when the real call resolves
* a failed call shows the real error, hides the percentage, offers retry
* retry restarts the real work
* the `route` variant registers no tasks, so no percentage and an
  indeterminate bar
* each context variant shows its own single panel and message, in a waiting
  state rather than a successful one
* WebGL initialises and the CSS composition stays as the fallback
* nothing escapes the viewport and no panels overlap at 1920, 1366 and 390px
* only one canvas exists after navigating away

The promise in `entry.jsx` is resolved BY THE TEST, never by a timer — which
is the property being tested.
