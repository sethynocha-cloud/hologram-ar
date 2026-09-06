/* Hologram AR — turns the live phone camera into a hologram with WebGL. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $('video'), canvas: $('view'), start: $('start'), startBtn: $('startBtn'),
    error: $('error'), hud: $('hud'), status: $('status'), statusText: $('statusText'),
    flipBtn: $('flipBtn'), fsBtn: $('fsBtn'), themeBtn: $('themeBtn'), themeLbl: $('themeLbl'),
    styleBtn: $('styleBtn'), styleLbl: $('styleLbl'), snapBtn: $('snapBtn'), recBtn: $('recBtn'),
    recLbl: $('recLbl'), toast: $('toast'), flash: $('flash'),
  };

  const THEMES = [
    { name: 'Cyan',     tint: [0.16, 0.86, 1.00], edge: [0.75, 1.00, 1.00], spectrum: 0 },
    { name: 'Matrix',   tint: [0.22, 1.00, 0.45], edge: [0.80, 1.00, 0.85], spectrum: 0 },
    { name: 'Amber',    tint: [1.00, 0.62, 0.14], edge: [1.00, 0.92, 0.70], spectrum: 0 },
    { name: 'Magenta',  tint: [1.00, 0.28, 0.88], edge: [1.00, 0.82, 1.00], spectrum: 0 },
    { name: 'Ice',      tint: [0.70, 0.86, 1.00], edge: [1.00, 1.00, 1.00], spectrum: 0 },
    { name: 'Spectrum', tint: [0.60, 0.80, 1.00], edge: [1.00, 1.00, 1.00], spectrum: 1 },
  ];

  const STYLES = [
    { name: 'Solid', fill: 0.55, edge: 1.00, contour: 0.0, real: 0.00, bloom: 1.00 },
    { name: 'Wire',  fill: 0.06, edge: 1.40, contour: 0.0, real: 0.00, bloom: 1.25 },
    { name: 'Scan',  fill: 0.30, edge: 0.90, contour: 1.0, real: 0.00, bloom: 1.00 },
    { name: 'Ghost', fill: 0.45, edge: 0.90, contour: 0.0, real: 0.62, bloom: 0.70 },
  ];

  const FX = { edgeGain: 2.6, glitch: 0.7, aberration: 0.0028, noise: 0.055, scanCssPx: 3, bloomRadius: 1.6, persist: 0.6 };
  const MAX_DPR = 1.5;        // cap backing-store scale: full DPR is wasted on a post-processed feed
  const MAX_RECORD_MS = 60000;

  const state = {
    running: false, theme: 0, style: 0, facing: 'environment', mirror: false,
    stream: null, deviceIds: [], deviceIndex: -1, quality: 1, t0: 0,
    recorder: null, recChunks: [], recTimer: 0, recStart: 0, wakeLock: null,
  };

  /* ---------------- WebGL ---------------- */

  const gl = els.canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });

  let progs = null, targets = null, videoTex = null, quadBuf = null;
  let vidW = 0, vidH = 0, contextLost = false, holoSwap = false;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function program(fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, HOLO_SHADERS.vert));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  function makeTexture() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function makeTarget() {
    const tex = makeTexture();
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w: 0, h: 0 };
  }

  function sizeTarget(t, w, h) {
    if (t.w === w && t.h === h) return;
    t.w = w; t.h = h;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  function initGL() {
    progs = {
      prep: program(HOLO_SHADERS.prep),
      holo: program(HOLO_SHADERS.holo),
      down: program(HOLO_SHADERS.down),
      blur: program(HOLO_SHADERS.blur),
      comp: program(HOLO_SHADERS.composite),
    };
    targets = { prep: makeTarget(), holoA: makeTarget(), holoB: makeTarget(), bloomA: makeTarget(), bloomB: makeTarget() };
    holoSwap = false;
    videoTex = makeTexture();
    vidW = vidH = 0;
    quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  els.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); contextLost = true; });
  els.canvas.addEventListener('webglcontextrestored', () => { initGL(); contextLost = false; });

  function resize() {
    const cssW = els.canvas.clientWidth || window.innerWidth;
    const cssH = els.canvas.clientHeight || window.innerHeight;
    const scale = Math.min(window.devicePixelRatio || 1, MAX_DPR) * state.quality;
    const w = Math.max(2, Math.round(cssW * scale));
    const h = Math.max(2, Math.round(cssH * scale));
    if (els.canvas.width !== w || els.canvas.height !== h) {
      els.canvas.width = w;
      els.canvas.height = h;
    }
    sizeTarget(targets.holoA, w, h);
    sizeTarget(targets.holoB, w, h);
    const bw = Math.max(2, Math.round(w / 4)), bh = Math.max(2, Math.round(h / 4));
    sizeTarget(targets.bloomA, bw, bh);
    sizeTarget(targets.bloomB, bw, bh);
    return { w, h, scale };
  }

  function uploadVideo() {
    const v = els.video;
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return false;
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    try {
      if (v.videoWidth !== vidW || v.videoHeight !== vidH) {
        vidW = v.videoWidth; vidH = v.videoHeight;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
      }
    } catch (err) {
      return false;
    }
    return true;
  }

  function drawPass(prog, target, setUniforms) {
    gl.useProgram(prog.p);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, els.canvas.width, els.canvas.height);
    }
    setUniforms(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function bindTex(unit, tex, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  function render(nowMs) {
    if (contextLost || !progs) return false;
    const { w, h, scale } = resize();
    if (!uploadVideo()) return false;

    const t = (nowMs - state.t0) / 1000;
    const theme = THEMES[state.theme], style = STYLES[state.style];

    // "Cover" crop so the camera fills the screen without stretching.
    const ca = w / h, va = vidW / vidH;
    const coverX = Math.min(1, ca / va), coverY = Math.min(1, va / ca);
    const mirror = state.mirror ? 1 : 0;

    // 1. Half-res, box-filtered luminance in camera space.
    const pw = Math.max(2, Math.ceil(vidW / 2)), ph = Math.max(2, Math.ceil(vidH / 2));
    sizeTarget(targets.prep, pw, ph);
    drawPass(progs.prep, targets.prep, (u) => {
      bindTex(0, videoTex, u.uVideo);
      gl.uniform2f(u.uTexel, 1 / vidW, 1 / vidH);
    });

    // 2. Edges + fill in screen space, ping-ponging for persistence.
    const holoCur = holoSwap ? targets.holoB : targets.holoA;
    const holoPrev = holoSwap ? targets.holoA : targets.holoB;
    holoSwap = !holoSwap;
    drawPass(progs.holo, holoCur, (u) => {
      bindTex(0, targets.prep.tex, u.uLuma);
      bindTex(1, holoPrev.tex, u.uPrev);
      gl.uniform2f(u.uTexel, 1 / pw, 1 / ph);
      gl.uniform2f(u.uCover, coverX, coverY);
      gl.uniform1f(u.uMirror, mirror);
      gl.uniform1f(u.uEdgeGain, FX.edgeGain);
      gl.uniform1f(u.uFillAmt, style.fill);
      gl.uniform1f(u.uEdgeAmt, style.edge);
      gl.uniform1f(u.uContour, style.contour);
      gl.uniform1f(u.uPersist, FX.persist);
    });

    // 3-4. Glow: downsample then separable blur.
    drawPass(progs.down, targets.bloomA, (u) => {
      bindTex(0, holoCur.tex, u.uTex);
      gl.uniform2f(u.uTexel, 1 / w, 1 / h);
    });

    const bw = targets.bloomA.w, bh = targets.bloomA.h;
    drawPass(progs.blur, targets.bloomB, (u) => {
      bindTex(0, targets.bloomA.tex, u.uTex);
      gl.uniform2f(u.uDir, FX.bloomRadius / bw, 0);
    });
    drawPass(progs.blur, targets.bloomA, (u) => {
      bindTex(0, targets.bloomB.tex, u.uTex);
      gl.uniform2f(u.uDir, 0, FX.bloomRadius / bh);
    });

    // 5. Composite to the screen.
    drawPass(progs.comp, null, (u) => {
      bindTex(0, holoCur.tex, u.uHolo);
      bindTex(1, targets.bloomA.tex, u.uBloom);
      bindTex(2, videoTex, u.uVideo);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform2f(u.uCover, coverX, coverY);
      gl.uniform1f(u.uMirror, mirror);
      gl.uniform1f(u.uTime, t);
      gl.uniform3fv(u.uTint, theme.tint);
      gl.uniform3fv(u.uEdgeTint, theme.edge);
      gl.uniform1f(u.uSpectrum, theme.spectrum);
      gl.uniform1f(u.uRealMix, style.real);
      gl.uniform1f(u.uBloomAmt, style.bloom);
      gl.uniform1f(u.uGlitch, FX.glitch);
      gl.uniform1f(u.uAberr, FX.aberration);
      gl.uniform1f(u.uScanPx, Math.max(2, FX.scanCssPx * scale));
      gl.uniform1f(u.uNoise, FX.noise);
    });
    return true;
  }

  /* ---------------- Render loop with adaptive quality ---------------- */

  let lastFrame = 0, frameAvg = 16, slowSince = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    if (!state.running) return;
    if (lastFrame) {
      const dt = Math.min(now - lastFrame, 100);
      frameAvg += (dt - frameAvg) * 0.05;
      // Sustained slowness: shrink the render size (never grows back, to avoid visible pumping).
      // Frozen while recording so the clip keeps one resolution.
      if (frameAvg > 28 && state.quality > 0.55 && !state.recorder) {
        if (!slowSince) slowSince = now;
        if (now - slowSince > 2000) {
          state.quality = Math.max(0.55, state.quality * 0.85);
          slowSince = 0; frameAvg = 16;
        }
      } else {
        slowSince = 0;
      }
    }
    lastFrame = now;
    render(now);
  }

  /* ---------------- Camera ---------------- */

  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach((tr) => tr.stop());
    state.stream = null;
  }

  async function openStream(videoConstraints) {
    return navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
  }

  async function startCamera(preferred, assumedFacing) {
    stopCamera();
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    let stream;
    try {
      stream = await openStream(Object.assign({}, base, preferred));
    } catch (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError' || err.name === 'NotFoundError')) {
        stream = await openStream(true); // any camera at all
      } else {
        throw err;
      }
    }
    state.stream = stream;
    els.video.srcObject = stream;
    try { await els.video.play(); } catch (err) { /* muted autoplay is allowed; ignore */ }

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    state.facing = settings.facingMode || assumedFacing || state.facing;
    state.mirror = state.facing === 'user';
    track.addEventListener('ended', () => {
      if (state.running) toast('Camera stopped');
    });

    // Once we have permission, device labels/ids are available.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.deviceIds = devices.filter((d) => d.kind === 'videoinput').map((d) => d.deviceId);
      state.deviceIndex = state.deviceIds.indexOf(settings.deviceId);
      els.flipBtn.hidden = state.deviceIds.length < 2;
    } catch (err) {
      els.flipBtn.hidden = false;
    }
    vidW = vidH = 0; // force a texture re-allocation on the next frame
  }

  async function flipCamera() {
    els.flipBtn.disabled = true;
    const next = state.facing === 'user' ? 'environment' : 'user';
    try {
      try {
        await startCamera({ facingMode: { exact: next } }, next);
      } catch (err) {
        // No camera facing that way (desktop webcams etc.): cycle through device ids instead.
        if (state.deviceIds.length > 1) {
          state.deviceIndex = (state.deviceIndex + 1) % state.deviceIds.length;
          await startCamera({ deviceId: { exact: state.deviceIds[state.deviceIndex] } }, next);
        } else {
          throw err;
        }
      }
      toast(state.facing === 'user' ? 'Front camera' : 'Back camera');
    } catch (err) {
      toast('Could not switch camera');
      try { await startCamera({ facingMode: { ideal: state.facing } }, state.facing); } catch (e2) { /* keep going */ }
    }
    els.flipBtn.disabled = false;
  }

  function describeError(err) {
    const name = err && err.name;
    if (!window.isSecureContext) {
      return 'Camera access needs a secure page. Open this app from an https:// link (or localhost).';
    }
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
      case 'SecurityError':
        return 'Camera access was blocked. Allow the camera for this site in your browser settings and try again. If this page is embedded inside another app, open it directly in your browser.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No camera was found on this device.';
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return 'The camera is busy in another app. Close it and try again.';
      default:
        return 'Could not start the camera: ' + ((err && err.message) || err);
    }
  }

  /* ---------------- UI helpers ---------------- */

  let toastTimer = 0;
  function toast(msg, ms) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms || 1800);
  }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }

  function applyTheme() {
    const theme = THEMES[state.theme];
    els.themeLbl.textContent = theme.name;
    const [r, g, b] = theme.tint.map((c) => Math.round(c * 255));
    const root = document.documentElement.style;
    root.setProperty('--accent', `rgb(${r}, ${g}, ${b})`);
    root.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.16)`);
    root.setProperty('--accent-line', `rgba(${r}, ${g}, ${b}, 0.45)`);
  }

  function applyStyle() {
    els.styleLbl.textContent = STYLES[state.style].name;
  }

  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // Share on phones when possible, otherwise download.
  async function deliver(file, title) {
    if (navigator.canShare && navigator.share) {
      try {
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user closed the share sheet
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Saved ' + file.name, 2500);
  }

  function capture() {
    if (!state.running) return;
    // Render and read back in the same task: the WebGL buffer is not preserved between frames.
    if (!render(performance.now())) { toast('Camera not ready yet'); return; }
    els.flash.classList.remove('go');
    void els.flash.offsetWidth;
    els.flash.classList.add('go');
    els.canvas.toBlob((blob) => {
      if (!blob) { toast('Capture failed'); return; }
      deliver(new File([blob], `hologram-${stamp()}.png`, { type: 'image/png' }), 'Hologram');
    }, 'image/png');
  }

  /* ---------------- Recording ---------------- */

  const canRecord = typeof MediaRecorder !== 'undefined' && typeof els.canvas.captureStream === 'function';

  function pickMime() {
    const list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const m of list) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (err) { /* ignore */ }
    }
    return '';
  }

  function setRecordingUi(on) {
    els.recBtn.classList.toggle('rec-on', on);
    els.status.classList.toggle('rec', on);
    els.recLbl.textContent = on ? 'Stop' : 'Record';
    els.statusText.textContent = on ? 'REC 0:00' : 'LIVE';
  }

  function startRecording() {
    let recorder, stream;
    try {
      stream = els.canvas.captureStream(30);
      const mime = pickMime();
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
    } catch (err) {
      toast('Recording is not supported here');
      return;
    }
    state.recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.recChunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const type = recorder.mimeType || 'video/webm';
      const ext = type.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
      const chunks = state.recChunks;
      state.recChunks = [];
      state.recorder = null;
      clearInterval(state.recTimer);
      setRecordingUi(false);
      if (!chunks.length) { toast('Nothing was recorded'); return; }
      deliver(new File(chunks, `hologram-${stamp()}.${ext}`, { type }), 'Hologram clip');
    };
    recorder.onerror = () => toast('Recording failed');
    recorder.start(500);
    state.recorder = recorder;
    state.recStart = performance.now();
    setRecordingUi(true);
    state.recTimer = setInterval(() => {
      const s = Math.floor((performance.now() - state.recStart) / 1000);
      els.statusText.textContent = `REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s * 1000 >= MAX_RECORD_MS) stopRecording();
    }, 250);
  }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  }

  function toggleRecording() {
    if (state.recorder) stopRecording(); else startRecording();
  }

  /* ---------------- Fullscreen / wake lock ---------------- */

  const docEl = document.documentElement;
  const fsSupported = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);

  function toggleFullscreen() {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    if (active) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen;
      try {
        const p = req.call(docEl, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(() => toast('Fullscreen not available'));
      } catch (err) {
        toast('Fullscreen not available');
      }
    }
  }

  async function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (err) { /* not critical */ }
  }

  /* ---------------- Start ---------------- */

  async function start() {
    els.error.hidden = true;
    els.startBtn.disabled = true;
    if (!gl) {
      showError('WebGL is not available in this browser, and the hologram needs it.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError(describeError({ name: 'NotSupported', message: 'camera API unavailable' }));
      els.startBtn.disabled = false;
      return;
    }
    try {
      if (!progs) initGL();
      await startCamera({ facingMode: { ideal: state.facing } }, state.facing);
    } catch (err) {
      showError(describeError(err));
      els.startBtn.disabled = false;
      return;
    }
    state.t0 = performance.now();
    state.running = true;
    els.start.hidden = true;
    els.hud.hidden = false;
    keepAwake();
    toast('Tap the screen to hide controls', 2600);
  }

  els.startBtn.addEventListener('click', start);
  els.flipBtn.addEventListener('click', flipCamera);
  els.snapBtn.addEventListener('click', capture);
  els.themeBtn.addEventListener('click', () => { state.theme = (state.theme + 1) % THEMES.length; applyTheme(); });
  els.styleBtn.addEventListener('click', () => { state.style = (state.style + 1) % STYLES.length; applyStyle(); });
  els.recBtn.addEventListener('click', toggleRecording);
  els.fsBtn.addEventListener('click', toggleFullscreen);
  els.canvas.addEventListener('click', () => { if (state.running) document.body.classList.toggle('hud-hidden'); });

  if (!canRecord) els.recBtn.hidden = true;
  if (!fsSupported) els.fsBtn.hidden = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.running) return;
    keepAwake();
    els.video.play().catch(() => {});
  });

  window.addEventListener('keydown', (e) => {
    if (!state.running || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); capture(); }
    else if (e.key === 't' || e.key === 'T') els.themeBtn.click();
    else if (e.key === 's' || e.key === 'S') els.styleBtn.click();
    else if ((e.key === 'r' || e.key === 'R') && !els.recBtn.hidden) els.recBtn.click();
    else if ((e.key === 'f' || e.key === 'F') && !els.flipBtn.hidden) els.flipBtn.click();
    else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('hud-hidden');
  });

  applyTheme();
  applyStyle();
  requestAnimationFrame(loop);

  // Small public surface for tinkering from the console (or automated tests).
  window.HologramAR = {
    start, capture, render, state, themes: THEMES, styles: STYLES, fx: FX,
    setTheme(i) { state.theme = ((i % THEMES.length) + THEMES.length) % THEMES.length; applyTheme(); },
    setStyle(i) { state.style = ((i % STYLES.length) + STYLES.length) % STYLES.length; applyStyle(); },
  };
})();
