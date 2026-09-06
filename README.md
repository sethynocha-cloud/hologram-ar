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

In the see-through styles (Wire, Scan, Ghost) the real camera image shows dimly behind the
hologram lines, and inside the brackets of every recognised object the true full-colour view is
revealed, so the hologram shows what is actually behind it.

The scan panel in the top-left corner tells you what the camera is looking at. An on-device
object detector (TensorFlow.js running SSDLite MobileNetV2 trained on COCO, 80 everyday classes:
people, animals, vehicles, furniture, phones, cups, laptops and so on) runs a couple of times a
second, lists what it sees with a confidence bar, and draws target brackets over each object.
Below the objects are live readouts computed from the frame: light level, motion, detail and colour
tone. The detector's 4.6 MB weights ship inside the repo, load once and are cached by the browser;
frames are still never uploaded anywhere. Photos and clips you save include the brackets and the
readout.

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
| Scan panel (top left) | Objects the camera recognises, with confidence, plus light / motion / detail / tone |
| Colour chip | Cycles the tint: Cyan, Matrix, Amber, Magenta, Ice, Spectrum |
| Style chip | Cycles the look: Solid, Wire (outlines only), Scan (contour lines), Ghost (real colour bleeds through) |
| Shutter | Saves a PNG (share sheet on phones, download elsewhere) |
| Save clip | The app records continuously from the moment the camera starts; tap to save the last 15–30 s as MP4/WebM |
| Stop (top right) | Turns the camera off, discards the clip buffer and returns to the start screen |
| Flip (top right) | Switches between back and front cameras |
| Fullscreen (top right) | Toggles fullscreen where the browser supports it |
| Tap the view | Hides or shows the controls |

Keyboard on desktop: `Space`/`Enter` capture, `T` theme, `S` style, `R` save clip, `F` flip, `H` hide HUD, `Esc` stop.

The always-on recorder keeps two overlapping 30-second buffers in memory (roughly 40 MB at the
default bitrate) and uses the phone's video encoder continuously, so expect somewhat higher battery
use than a plain camera preview.

## Security and privacy

The whole app is client-side, and it is built so that nothing leaves the device and nothing
unexpected runs on it:

- **Strict Content Security Policy.** The page only executes scripts and styles from its own
  origin, connects only to itself, and cannot be used as a base for injected content
  (`default-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`).
- **Everything is pinned by hash.** The two vendored libraries load with Subresource Integrity,
  and the detector's model files are fetched, SHA-384 checked in the browser, and only then handed
  to TensorFlow.js. A tampered file is refused and the panel shows VISION · BLOCKED. Regenerate
  the hashes with `node tools/integrity.mjs` after changing anything under `vendor/`.
- **No third parties.** No CDN, analytics, fonts or model downloads from other hosts; the network
  policy would block them anyway.
- **Camera only while you are looking.** The camera, recognition and the clip buffer stop as soon
  as the app leaves the screen (another tab, lock screen, home screen) and resume when it comes
  back. The stop button in the top-right turns everything off and discards the buffer. Footage
  exists only in memory, for at most 30 seconds, until you choose to save it.
- **Not embeddable.** The app refuses to start inside another site's frame, so a malicious page
  cannot overlay it and trick you into activating the camera (clickjacking).
- **No leaks in the small things.** `referrer` is `no-referrer`, downloads use generated
  timestamp filenames, labels are inserted as text (never HTML), and object URLs are revoked.
- **HTTPS only.** Camera access requires a secure context, GitHub Pages enforces HTTPS, and the
  policy upgrades any insecure request.

What hosting cannot do: GitHub Pages does not let a site set HTTP response headers, so
`frame-ancestors`, HSTS and `Permissions-Policy` cannot be enforced at the header level. Putting the
site behind a host that supports custom headers (Cloudflare Pages, Netlify) would add those.

## Run locally

Any static server works. Camera access is allowed on `localhost`:

```sh
npx serve .          # or: python3 -m http.server 8000
```

To test on a phone over your LAN you need HTTPS; the simplest route is to push and use GitHub Pages.

## Tinkering

`shaders.js` holds the GLSL; `app.js` holds the themes, styles and effect constants (`THEMES`,
`STYLES`, `FX`); `vision.js` holds the detector, the object tracker and the frame statistics
(`HoloVision.settings` for the run interval and score threshold). Everything is exposed at runtime
as `window.HologramAR` so you can experiment from the browser console, e.g. `HologramAR.fx.glitch = 2`,
`HologramAR.setTheme(2)` or `HologramAR.vision.settings.minScore = 0.3`.

## Files

```
index.html               markup
style.css                start screen, HUD and scan panel styling
shaders.js               WebGL shader sources
app.js                   camera, render loop, capture, recording, UI
vision.js                on-device object detection, tracking, frame statistics
vendor/                  TensorFlow.js (ES2017 build), coco-ssd and the quantized detector weights (see vendor/README.md)
tools/quantize-model.mjs re-packs TF.js weights as 8-bit (how vendor/coco-ssd-lite was made)
manifest.webmanifest     PWA manifest (icon.svg, icon-*.png)
.github/workflows/       GitHub Pages deployment
```
