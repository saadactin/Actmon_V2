# Source artwork

Masters, kept out of `public/` because everything in there is copied verbatim
into the build — these were adding 17 MB to a bundle that needs the derived
files only.

| Source | Derived (in `public/`) | Why |
|---|---|---|
| `loader-frames-source/step1..10.png` (16 MB) | `loader/step1..10.webp` (615 KB) | Cropped to the lit stage band — each frame had a progress bar, a percentage and a message painted into it, and the loader renders the real ones. Resized to 1600px, WebP q80. |
| `ACTMON Cloud Monitoring Logo.png` (1.3 MB) | `actmon-mark.webp`, `actmon-mark-sm.webp`, `actmon-mark.png` | The icon only. The wordmark in the master is near-black on black, so it disappears on the navy top bar and cannot be used on a light surface; "ACTMON" is live text instead. The black field is knocked out by treating luminance as alpha and un-premultiplying the colour, so the glow composites as light rather than as grey smoke. |

To regenerate after replacing a master, see the asset steps in the session
notes — PIL only, no build-time image pipeline.
