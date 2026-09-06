/* On-device scene understanding for Hologram AR.
 *
 * Runs a small COCO object detector (TF.js + coco-ssd, weights vendored and 8-bit quantized)
 * against the raw camera frames, tracks detections between runs so boxes and labels stay
 * put, and computes cheap per-frame statistics (light, motion, detail, colour tone) from a
 * downscaled copy of the frame. Nothing leaves the device.
 */
(function () {
  'use strict';

  // Everything the detector runs or loads is pinned by hash. If a file does not match, it is
  // not used. Regenerate these after changing anything in vendor/: node tools/integrity.mjs
  const SCRIPTS = [
    { src: 'vendor/tf.es2017.min.js', integrity: 'sha384-ODzrY1mCTIRZRerZfDIqCoTQafA1St1OwLVc9SsTefnkCF1MeIaVSZ88wuK/NKfH', ready: () => window.tf },
    { src: 'vendor/coco-ssd.min.js', integrity: 'sha384-7qLdgfEQyO9ZQi9ArRHigK+IBto4XPk468jAqc+fnsXaZIcMAhQeLwzggRK7aESl', ready: () => window.cocoSsd },
  ];
  const MODEL_FILES = [
    { path: 'vendor/coco-ssd-lite/model.json', integrity: 'sha384-GDq1qierYfWAP95LegcOyjByNJbDzrcPugOfSfcyMCvVD37r3ndOoQe8JOOa+qb/' },
    { path: 'vendor/coco-ssd-lite/group1-shard1of2.bin', integrity: 'sha384-6Lnby+REfsp8DqJODr/s3q8vRbVK/INiJzI73EFd6YHsxPeAFwPTrR293HTCXWQH' },
    { path: 'vendor/coco-ssd-lite/group1-shard2of2.bin', integrity: 'sha384-Fa2eZaZLVp32YCfLyh1DYH7g6dKe50tK+oK5kFzQgASy/axn51kkPht4Zt2iZeg+' },
  ];

  const settings = {
    interval: 450,     // ms gap between detector runs (the GPU is shared with the hologram)
    cpuInterval: 2500, // gap when TF.js fell back to the CPU backend, which blocks the main thread
    minScore: 0.45,
    maxObjects: 6,
    trackTtl: 1600,    // ms an object survives without being re-detected
    inputWidth: 320,   // detector input; the model resizes to 300x300 internally anyway
  };

  const state = {
    status: 'idle',    // idle | loading | warming | ready | error | blocked | off
    objects: [],       // [{ id, label, score, box: [x0, y0, x1, y1] normalised to the video frame }]
    stats: { light: 0, motion: 0, detail: 0, tone: '--', fps: 0 },
    error: null,
  };

  const listeners = new Set();
  let model = null, video = null, running = false, timer = 0, lastRun = 0;
  const tracks = [];
  let nextId = 1;

  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const tiny = document.createElement('canvas');
  const tctx = tiny.getContext('2d', { willReadFrequently: true });
  let prevLuma = null;

  function emit() { listeners.forEach((fn) => { try { fn(state); } catch (err) { /* listener error */ } }); }
  function setStatus(status, error) { state.status = status; state.error = error || null; emit(); }

  async function sha384(buf) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', buf));
    let bin = '';
    for (let i = 0; i < digest.length; i++) bin += String.fromCharCode(digest[i]);
    return 'sha384-' + btoa(bin);
  }

  // Subresource Integrity: the browser refuses the script unless its hash matches. On failure,
  // hash the file ourselves to tell a tampered file (blocked) from a network problem (offline).
  function loadScript(entry) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = entry.src;
      s.integrity = entry.integrity;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = resolve;
      s.onerror = async () => {
        let tampered = false;
        try {
          const res = await fetch(entry.src);
          tampered = res.ok && (await sha384(await res.arrayBuffer())) !== entry.integrity;
        } catch (err) { /* unreachable: treat as offline */ }
        const err = new Error((tampered ? 'Integrity check failed for ' : 'Could not load ') + entry.src);
        err.integrity = tampered;
        reject(err);
      };
      document.head.appendChild(s);
    });
  }

  // Fetches a model file and checks its SHA-384 before it is handed to TF.js.
  async function fetchVerified(entry) {
    const res = await fetch(entry.path);
    if (!res.ok) throw new Error('Could not fetch ' + entry.path);
    const buf = await res.arrayBuffer();
    if ((await sha384(buf)) !== entry.integrity) {
      const err = new Error('Integrity check failed for ' + entry.path);
      err.integrity = true;
      throw err;
    }
    const name = entry.path.split('/').pop();
    return new File([buf], name, { type: name.slice(-5) === '.json' ? 'application/json' : 'application/octet-stream' });
  }

  async function ensureModel() {
    if (model) return model;
    setStatus('loading');
    for (const s of SCRIPTS) if (!s.ready()) await loadScript(s);
    if (tf.enableProdMode) tf.enableProdMode();
    try { await tf.setBackend('webgl'); } catch (err) { /* falls back to whatever tf picks */ }
    await tf.ready();
    const files = await Promise.all(MODEL_FILES.map(fetchVerified));
    model = await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: tf.io.browserFiles(files) });
    setStatus('warming');
    return model;
  }

  /* ---------- per-frame statistics ---------- */

  function computeStats() {
    const gw = 48, gh = Math.max(8, Math.round(gw * video.videoHeight / video.videoWidth));
    if (tiny.width !== gw || tiny.height !== gh) { tiny.width = gw; tiny.height = gh; prevLuma = null; }
    tctx.drawImage(video, 0, 0, gw, gh);
    const d = tctx.getImageData(0, 0, gw, gh).data;
    const n = gw * gh;
    const luma = new Float32Array(n);
    let sumL = 0, sumR = 0, sumB = 0;
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      luma[i] = l; sumL += l; sumR += r; sumB += b;
    }
    let motion = 0;
    if (prevLuma) { for (let i = 0; i < n; i++) motion += Math.abs(luma[i] - prevLuma[i]); motion /= n; }
    prevLuma = luma;
    let detail = 0, cnt = 0;
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      detail += Math.abs(luma[i + 1] - luma[i - 1]) + Math.abs(luma[i + gw] - luma[i - gw]);
      cnt++;
    }
    detail /= Math.max(1, cnt);
    const warmth = (sumR - sumB) / n;
    state.stats.light = Math.round(Math.min(1, sumL / n) * 100);
    state.stats.motion = Math.round(Math.min(1, motion / 0.12) * 100);
    state.stats.detail = Math.round(Math.min(1, detail / 0.28) * 100);
    state.stats.tone = warmth > 14 ? 'WARM' : warmth < -14 ? 'COOL' : 'NEUTRAL';
  }

  /* ---------- tracking ---------- */

  function iou(a, b) {
    const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
    const x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return ua > 0 ? inter / ua : 0;
  }

  // Drop a same-class box that mostly sits inside a stronger one (the detector's own NMS
  // only catches near-identical boxes).
  function suppressNested(dets) {
    const sorted = dets.slice().sort((a, b) => b.score - a.score);
    const keep = [];
    for (const d of sorted) {
      const area = (d.box[2] - d.box[0]) * (d.box[3] - d.box[1]);
      const nested = keep.some((k) => {
        if (k.label !== d.label) return false;
        const x0 = Math.max(k.box[0], d.box[0]), y0 = Math.max(k.box[1], d.box[1]);
        const x1 = Math.min(k.box[2], d.box[2]), y1 = Math.min(k.box[3], d.box[3]);
        const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
        const karea = (k.box[2] - k.box[0]) * (k.box[3] - k.box[1]);
        return inter / Math.max(1e-6, Math.min(area, karea)) > 0.7;
      });
      if (!nested) keep.push(d);
    }
    return keep;
  }

  function updateTracks(dets, now) {
    const free = new Set(tracks);
    for (const d of dets) {
      let best = null, bestIou = 0.3;
      for (const t of free) {
        if (t.label !== d.label) continue;
        const v = iou(t.box, d.box);
        if (v > bestIou) { best = t; bestIou = v; }
      }
      if (best) {
        free.delete(best);
        for (let i = 0; i < 4; i++) best.box[i] += (d.box[i] - best.box[i]) * 0.6;
        best.score += (d.score - best.score) * 0.5;
        best.seen = now;
        best.hits++;
      } else {
        tracks.push({ id: nextId++, label: d.label, box: d.box.slice(), score: d.score, seen: now, hits: 1 });
      }
    }
    for (let i = tracks.length - 1; i >= 0; i--) if (now - tracks[i].seen > settings.trackTtl) tracks.splice(i, 1);
    state.objects = tracks.slice().sort((a, b) => b.score - a.score).slice(0, settings.maxObjects);
  }

  /* ---------- detection loop ---------- */

  async function step() {
    timer = 0;
    if (!running) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (video.readyState < 2 || !vw || !vh) { schedule(150); return; }
    const t0 = performance.now();
    try {
      computeStats();
      const w = settings.inputWidth, h = Math.max(16, Math.round(w * vh / vw));
      if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
      wctx.drawImage(video, 0, 0, w, h);
      const raw = model ? await model.detect(work, settings.maxObjects + 4, settings.minScore) : [];
      const dets = raw.map((r) => ({
        label: r.class,
        score: r.score,
        box: [r.bbox[0] / w, r.bbox[1] / h, (r.bbox[0] + r.bbox[2]) / w, (r.bbox[1] + r.bbox[3]) / h],
      }));
      const now = performance.now();
      updateTracks(suppressNested(dets), now);
      state.stats.fps = Math.round(10000 / Math.max(1, now - t0)) / 10;
      if (model && state.status !== 'ready') state.status = 'ready';
      emit();
    } catch (err) {
      setStatus('error', err);
      return;
    }
    lastRun = performance.now();
    // Always leave a gap after a run so a slow device keeps a responsive UI.
    const slow = !model || (window.tf && tf.getBackend && tf.getBackend() === 'cpu');
    schedule(slow ? settings.cpuInterval : settings.interval);
  }

  function schedule(ms) {
    if (!running || timer) return;
    timer = setTimeout(step, ms);
  }

  async function start(videoEl) {
    video = videoEl;
    if (running) return;
    running = true;
    try {
      await ensureModel();
    } catch (err) {
      // No detector (tampered file, offline, old browser): keep the frame statistics running anyway.
      setStatus(err && err.integrity ? 'blocked' : 'error', err);
    }
    if (running) schedule(0);
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = 0;
    tracks.length = 0;
    prevLuma = null;
    state.objects = [];
    setStatus(model ? 'off' : 'idle');
  }

  window.HoloVision = {
    state, settings, start, stop,
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
