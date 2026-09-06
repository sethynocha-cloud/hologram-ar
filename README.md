# Hologram AR

Point your phone camera at anything and watch the world turn into a live hologram.

It is a single static web page: no build step, no dependencies, nothing uploaded.
The camera feed goes through a small WebGL pipeline on the phone's GPU:

1. **Prep** – half-resolution, box-filtered luminance so sensor noise does not read as edges.
2. **Holo** – Sobel edge detection plus a luminance "fill", blended with the previous frame for a
   slow-phosphor persistence.
3. **Glow** – quarter-resolution downsample and a separable gaussian blur for bloom.
4. **Composite** – tint, chromatic aberration, crawling scanlines, a rolling band, random dropout
   rows, grain, flicker, glitch bursts and a vignette.

## Try it on your phone

The camera API only works on `https://` pages (or `localhost`), so the page has to be hosted.

**GitHub Pages (recommended).** The workflow in `.github/workflows/deploy-pages.yml` deploys the
site on every push to `main`. After the first run the app lives at:

```
https://sethynocha-cloud.github.io/hologram-ar/
```

The workflow tries to enable GitHub Pages for the repository automatically. If the first run fails
with a Pages error, enable it once by hand: **Settings → Pages → Build and deployment → Source:
GitHub Actions**, then re-run the workflow.

Open the link on your phone, tap **Activate Camera**, allow camera access. For a full-screen,
app-like feel use *Add to Home Screen* (the page ships a web-app manifest and icons).

## Controls

| Control | What it does |
| --- | --- |
| Colour chip | Cycles the tint: Cyan, Matrix, Amber, Magenta, Ice, Spectrum |
| Style chip | Cycles the look: Solid, Wire (outlines only), Scan (contour lines), Ghost (real colour bleeds through) |
| Shutter | Saves a PNG (share sheet on phones, download elsewhere) |
| Record | Records up to 60 s of the hologram as MP4/WebM, then shares or downloads it |
| Flip (top right) | Switches between back and front cameras |
| Fullscreen (top right) | Toggles fullscreen where the browser supports it |
| Tap the view | Hides or shows the controls |

Keyboard on desktop: `Space`/`Enter` capture, `T` theme, `S` style, `R` record, `F` flip, `H` hide HUD.

## Run locally

Any static server works. Camera access is allowed on `localhost`:

```sh
npx serve .          # or: python3 -m http.server 8000
```

To test on a phone over your LAN you need HTTPS; the simplest route is to push and use GitHub Pages.

## Tinkering

`shaders.js` holds the GLSL; `app.js` holds the themes, styles and effect constants (`THEMES`,
`STYLES`, `FX`). Everything is exposed at runtime as `window.HologramAR` so you can experiment from
the browser console, e.g. `HologramAR.fx.glitch = 2` or `HologramAR.setTheme(2)`.

## Files

```
index.html               markup
style.css                start screen and HUD styling
shaders.js               WebGL shader sources
app.js                   camera, render loop, capture, recording, UI
manifest.webmanifest     PWA manifest (icon.svg, icon-*.png)
.github/workflows/       GitHub Pages deployment
```
