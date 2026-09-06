/* Hologram AR — turns the live phone camera into a hologram with WebGL. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $('video'), canvas: $('view'), start: $('start'), startBtn: $('startBtn'),
    error: $('error'), hud: $('hud'), scan: $('scan'), statusText: $('statusText'),
    visionState: $('visionState'), objects: $('objects'), targets: $('targets'),
    statLight: $('statLight'), statLightV: $('statLightV'), statMotion: $('statMotion'), statMotionV: $('statMotionV'),
    statDetail: $('statDetail'), statDetailV: $('statDetailV'), statTone: $('statTone'),
    flipBtn: $('flipBtn'), fsBtn: $('fsBtn'), stopBtn: $('stopBtn'), themeBtn: $('themeBtn'), themeLbl: $('themeLbl'),
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

  // real: how much of the actual camera image shows through; realSat: its colour saturation;
  // reveal: how fully recognised objects show the true view inside their brackets.
  const STYLES = [
    { name: 'Solid', fill: 0.55, edge: 1.00, contour: 0.0, real: 0.00, realSat: 1.00, reveal: 0.0, bloom: 1.00 },
    { name: 'Wire',  fill: 0.06, edge: 1.40, contour: 0.0, real: 0.40, realSat: 0.35, reveal: 0.9, bloom: 1.25 },
    { name: 'Scan',  fill: 0.30, edge: 0.90, contour: 1.0, real: 0.30, realSat: 0.30, reveal: 0.9, bloom: 1.00 },
    { name: 'Ghost', fill: 0.45, edge: 0.90, contour: 0.0, real: 0.62, realSat: 1.00, reveal: 1.0, bloom: 0.70 },
  ];

  const FX = { edgeGain: 2.6, glitch: 0.7, aberration: 0.0028, noise: 0.055, scanCssPx: 3, bloomRadius: 1.6, persist: 0.6 };
  const MAX_DPR = 1.5;        // cap backing-store scale: full DPR is wasted on a post-processed feed

  const state = {
    running: false, theme: 0, style: 0, facing: 'environment', mirror: false,
    stream: null, deviceIds: [], deviceIndex: -1, quality: 1, t0: 0, cover: [1, 1],
    wakeLock: null, accent: '#34e0ff', sharing: false,
  };

  // Clickjacking defence: a page that embeds this app could overlay it and trick a tap on
  // "Activate Camera". Refuse to run anywhere but the top-level window.
  const framed = (() => { try { return window.top !== window.self; } catch (err) { return true; } })();

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
      if (info.name.slice(-3) === '[0]') u[info.name.slice(0, -3)] = u[info.name];
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
    state.cover[0] = coverX; state.cover[1] = coverY;
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
      gl.uniform1f(u.uRealSat, style.realSat);
      gl.uniform1f(u.uReveal, style.reveal);
      const nBoxes = style.reveal > 0 ? revealBoxes() : 0;
      gl.uniform1i(u.uBoxCount, nBoxes);
      if (nBoxes) gl.uniform4fv(u.uBoxes, boxData);
      gl.uniform1f(u.uBloomAmt, style.bloom);
      gl.uniform1f(u.uGlitch, FX.glitch);
      gl.uniform1f(u.uAberr, FX.aberration);
      gl.uniform1f(u.uScanPx, Math.max(2, FX.scanCssPx * scale));
      gl.uniform1f(u.uNoise, FX.noise);
    });
    return true;
  }

  // Recognised-object boxes for the shader's reveal windows, eased per frame so they glide.
  const smoothRects = new Map();
  const boxData = new Float32Array(24);

  function revealBoxes() {
    const cw = els.canvas.clientWidth || 1, ch = els.canvas.clientHeight || 1;
    const seen = new Set();
    let n = 0;
    for (const o of HoloVision.state.objects) {
      if (n >= 6) break;
      const r = boxToScreen(o.box);
      let sm = smoothRects.get(o.id);
      if (!sm) {
        sm = { x: r.x, y: r.y, w: r.w, h: r.h };
        smoothRects.set(o.id, sm);
      } else {
        sm.x += (r.x - sm.x) * 0.2; sm.y += (r.y - sm.y) * 0.2;
        sm.w += (r.w - sm.w) * 0.2; sm.h += (r.h - sm.h) * 0.2;
      }
      seen.add(o.id);
      boxData[n * 4] = sm.x / cw;
      boxData[n * 4 + 1] = 1 - (sm.y + sm.h) / ch;
      boxData[n * 4 + 2] = (sm.x + sm.w) / cw;
      boxData[n * 4 + 3] = 1 - sm.y / ch;
      n++;
    }
    for (const id of Array.from(smoothRects.keys())) if (!seen.has(id)) smoothRects.delete(id);
    return n;
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
      if (frameAvg > 28 && state.quality > 0.55) {
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
    if (render(now) && rolling.active) {
      checkRollingShape();
      composeFrame(rolling.ctx, rolling.canvas.width, rolling.canvas.height);
    }
  }

  /* ---------------- Camera ---------------- */

  let cameraGen = 0;

  function stopCamera() {
    cameraGen++; // any acquisition still in flight is discarded when it resolves
    if (state.stream) state.stream.getTracks().forEach((tr) => tr.stop());
    state.stream = null;
  }

  async function openStream(videoConstraints) {
    return navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
  }

  async function startCamera(preferred, assumedFacing) {
    stopCamera();
    const gen = cameraGen;
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
    // Stopped or hidden while the camera was starting: do not let it go live.
    if (gen !== cameraGen || (document.visibilityState === 'hidden' && !state.sharing)) {
      stream.getTracks().forEach((tr) => tr.stop());
      const err = new Error('Camera start cancelled');
      err.cancelled = true;
      throw err;
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

  function showError(msg, note) {
    els.error.textContent = msg;
    els.error.classList.toggle('note', !!note);
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
    state.accent = `rgb(${r}, ${g}, ${b})`;
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
          state.sharing = true;
          await navigator.share({ files: [file], title });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user closed the share sheet
      } finally {
        setTimeout(() => {
          state.sharing = false;
          if (document.visibilityState === 'hidden') pauseForBackground();
        }, 1000);
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
    const out = document.createElement('canvas');
    out.width = els.canvas.width;
    out.height = els.canvas.height;
    composeFrame(out.getContext('2d'), out.width, out.height);
    out.toBlob((blob) => {
      if (!blob) { toast('Capture failed'); return; }
      deliver(new File([blob], `hologram-${stamp()}.png`, { type: 'image/png' }), 'Hologram');
    }, 'image/png');
  }

  /* ---------------- Scene readout (vision.js) ---------------- */

  const targetEls = new Map();

  // Video-space box [x0, y0, x1, y1] (0..1) -> CSS pixel rect, through the cover crop and mirror.
  function boxToScreen(box) {
    const W = els.canvas.clientWidth, H = els.canvas.clientHeight;
    const [cx, cy] = state.cover;
    let x0 = box[0], x1 = box[2];
    if (state.mirror) { const a = 1 - x1; x1 = 1 - x0; x0 = a; }
    const sx0 = ((x0 - 0.5) / cx + 0.5) * W, sx1 = ((x1 - 0.5) / cx + 0.5) * W;
    const sy0 = ((box[1] - 0.5) / cy + 0.5) * H, sy1 = ((box[3] - 0.5) / cy + 0.5) * H;
    return { x: sx0, y: sy0, w: sx1 - sx0, h: sy1 - sy0 };
  }

  function objectLabel(o) {
    return `${o.label.toUpperCase()} ${Math.round(o.score * 100)}%`;
  }

  function visionStatusText(v) {
    const n = v.objects.length;
    switch (v.status) {
      case 'loading': return 'VISION · LOADING';
      case 'warming': return 'VISION · CALIBRATING';
      case 'ready': return n ? `VISION · ${n} OBJECT${n > 1 ? 'S' : ''}` : 'VISION · SCANNING';
      case 'error': return 'VISION · OFFLINE';
      case 'blocked': return 'VISION · BLOCKED';
      case 'off': return 'VISION · OFF';
      default: return '';
    }
  }

  function layoutTargets() {
    const v = HoloVision.state;
    const seen = new Set();
    for (const o of v.objects) {
      let el = targetEls.get(o.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'target';
        el.appendChild(document.createElement('span')).className = 'tag';
        els.targets.appendChild(el);
        targetEls.set(o.id, el);
      }
      seen.add(o.id);
      const r = boxToScreen(o.box);
      el.style.transform = `translate(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px)`;
      el.style.width = `${Math.max(8, r.w).toFixed(1)}px`;
      el.style.height = `${Math.max(8, r.h).toFixed(1)}px`;
      el.style.setProperty('--corner', `${Math.max(8, Math.min(22, Math.min(r.w, r.h) * 0.22)).toFixed(0)}px`);
      // Keep the label readable when the box runs off the left or top edge.
      el.firstChild.style.left = `${Math.max(0, -r.x).toFixed(0)}px`;
      el.classList.toggle('inside', r.y < 26);
      el.firstChild.textContent = objectLabel(o);
    }
    for (const [id, el] of targetEls) {
      if (!seen.has(id)) { el.remove(); targetEls.delete(id); }
    }
  }

  function renderVision(v) {
    els.visionState.textContent = visionStatusText(v);
    els.visionState.classList.toggle('busy', v.status === 'loading' || v.status === 'warming' || (v.status === 'ready' && !v.objects.length));
    els.objects.textContent = '';
    for (const o of v.objects) {
      const li = document.createElement('li');
      const name = li.appendChild(document.createElement('span'));
      name.className = 'obj-name';
      name.textContent = o.label;
      const bar = li.appendChild(document.createElement('span'));
      bar.className = 'bar';
      bar.appendChild(document.createElement('b')).style.width = `${Math.round(o.score * 100)}%`;
      const score = li.appendChild(document.createElement('span'));
      score.className = 'obj-score';
      score.textContent = `${Math.round(o.score * 100)}%`;
      els.objects.appendChild(li);
    }
    els.objects.hidden = v.objects.length === 0;
    const st = v.stats;
    els.statLight.style.width = `${st.light}%`; els.statLightV.textContent = `${st.light}%`;
    els.statMotion.style.width = `${st.motion}%`; els.statMotionV.textContent = `${st.motion}%`;
    els.statDetail.style.width = `${st.detail}%`; els.statDetailV.textContent = `${st.detail}%`;
    els.statTone.textContent = st.tone;
    if ((v.status === 'error' || v.status === 'blocked') && !renderVision.warned) {
      renderVision.warned = true;
      toast(v.status === 'blocked' ? 'Vision model failed its integrity check and was not loaded' : 'Object recognition unavailable here', 3200);
    }
    layoutTargets();
  }

  // Draws the hologram plus (unless the HUD is hidden) the brackets and readout into a 2D context.
  function composeFrame(ctx, W, H) {
    ctx.drawImage(els.canvas, 0, 0, W, H);
    if (document.body.classList.contains('hud-hidden') || !state.running) return;
    const k = W / Math.max(1, els.canvas.clientWidth);
    const v = HoloVision.state;
    const accent = state.accent;
    const mono = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.save();
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = accent;
    ctx.font = `bold ${Math.round(10 * k)}px ${mono}`;
    ctx.textBaseline = 'alphabetic';
    for (const o of v.objects) {
      const r = boxToScreen(o.box);
      const x = r.x * k, y = r.y * k, w = r.w * k, h = r.h * k;
      const L = Math.max(8, Math.min(22, Math.min(r.w, r.h) * 0.22)) * k;
      ctx.beginPath();
      ctx.moveTo(x, y + L); ctx.lineTo(x, y); ctx.lineTo(x + L, y);
      ctx.moveTo(x + w - L, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + L);
      ctx.moveTo(x + w, y + h - L); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - L, y + h);
      ctx.moveTo(x + L, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - L);
      ctx.stroke();
      const text = objectLabel(o);
      const tw = ctx.measureText(text).width + 12 * k, th = 16 * k;
      const tx = Math.max(0, x), ty = y - th - 3 * k < 0 ? y + 3 * k : y - th - 3 * k;
      ctx.fillStyle = 'rgba(2, 5, 10, 0.75)';
      ctx.fillRect(tx, ty, tw, th);
      ctx.fillStyle = accent;
      ctx.fillText(text, tx + 6 * k, ty + th - 5 * k);
    }
    // Readout block, where the panel sits on screen.
    const rect = els.scan.getBoundingClientRect();
    const lines = [`● ${els.statusText.textContent}   ${visionStatusText(v)}`];
    for (const o of v.objects) lines.push(`▸ ${objectLabel(o)}`);
    const st = v.stats;
    lines.push(`LIGHT ${st.light}%  MOTION ${st.motion}%  DETAIL ${st.detail}%`);
    lines.push(`TONE ${st.tone}`);
    const pad = 8 * k, lh = 14 * k;
    let bw = 0;
    for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width);
    bw += pad * 2;
    const bx = rect.left * k, by = rect.top * k, bh = lines.length * lh + pad * 2 - 4 * k;
    ctx.fillStyle = 'rgba(2, 5, 10, 0.7)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1 * k;
    ctx.strokeRect(bx + 0.5 * k, by + 0.5 * k, bw - k, bh - k);
    ctx.fillStyle = accent;
    lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + lh * (i + 1) - 4 * k));
    ctx.restore();
  }

  /* ---------------- Always-on rolling recorder ---------------- */
  // The composited output is recorded continuously. Two MediaRecorders share the stream,
  // half a buffer apart, each restarted every BUFFER_SECONDS, so whichever has run longest
  // always holds at least half a buffer. "Save" stops that one, which yields a valid file
  // covering the last 15-30 s, and restarts it. Memory stays bounded to two buffers.

  const BUFFER_SECONDS = 30;
  const canRecord = typeof MediaRecorder !== 'undefined' && typeof els.canvas.captureStream === 'function';
  const rolling = { canvas: null, ctx: null, stream: null, slots: [], active: false, saving: false, uiTimer: 0 };

  function pickMime() {
    const list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const m of list) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (err) { /* ignore */ }
    }
    return '';
  }

  function slotStart(slot) {
    if (!rolling.active || rolling.slots.indexOf(slot) === -1) return false;
    const mime = pickMime();
    let rec;
    try {
      rec = new MediaRecorder(rolling.stream, mime ? { mimeType: mime, videoBitsPerSecond: 5e6 } : undefined);
    } catch (err) {
      return false;
    }
    slot.rec = rec;
    slot.chunks = [];
    slot.startedAt = performance.now();
    slot.deliver = false;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) slot.chunks.push(e.data); };
    rec.onstop = () => {
      const chunks = slot.chunks, deliver = slot.deliver;
      slot.chunks = []; slot.deliver = false; slot.rec = null;
      if (deliver) finishClip(chunks, rec.mimeType || mime || 'video/webm');
      slotStart(slot);
    };
    rec.onerror = () => { rolling.saving = false; };
    rec.start(1000);
    // Never run longer than one buffer.
    clearTimeout(slot.maxTimer);
    slot.maxTimer = setTimeout(() => { if (slot.rec === rec && rec.state === 'recording') rec.stop(); }, BUFFER_SECONDS * 1000);
    // Keep the other recorder half a buffer out of phase.
    const other = rolling.slots[1 - rolling.slots.indexOf(slot)];
    if (other) {
      clearTimeout(other.restartTimer);
      other.restartTimer = setTimeout(() => {
        if (!rolling.active) return;
        if (other.rec && other.rec.state === 'recording') other.rec.stop(); else slotStart(other);
      }, BUFFER_SECONDS * 500);
    }
    return true;
  }

  function bufferedSeconds() {
    let best = 0;
    for (const sl of rolling.slots) {
      if (sl.rec && sl.rec.state === 'recording') best = Math.max(best, (performance.now() - sl.startedAt) / 1000);
    }
    return Math.min(BUFFER_SECONDS, Math.floor(best));
  }

  function startRolling() {
    if (!canRecord || rolling.active) return;
    const rc = document.createElement('canvas');
    rc.width = els.canvas.width;
    rc.height = els.canvas.height;
    const ctx = rc.getContext('2d');
    let stream;
    try {
      composeFrame(ctx, rc.width, rc.height);
      stream = rc.captureStream(30);
    } catch (err) {
      els.recBtn.hidden = true;
      return;
    }
    rolling.canvas = rc; rolling.ctx = ctx; rolling.stream = stream;
    rolling.slots = [{ restartTimer: 0, maxTimer: 0 }, { restartTimer: 0, maxTimer: 0 }];
    rolling.active = true;
    if (!slotStart(rolling.slots[0])) {
      stopRolling();
      els.recBtn.hidden = true;
      return;
    }
    els.recBtn.classList.add('buffering');
    clearInterval(rolling.uiTimer);
    rolling.uiTimer = setInterval(() => {
      if (!rolling.saving) els.recLbl.textContent = `Save ${bufferedSeconds()}s`;
    }, 500);
  }

  function stopRolling() {
    rolling.active = false;
    for (const sl of rolling.slots) {
      clearTimeout(sl.restartTimer);
      clearTimeout(sl.maxTimer);
      if (sl.rec && sl.rec.state !== 'inactive') { sl.deliver = false; sl.rec.stop(); }
    }
    if (rolling.stream) rolling.stream.getTracks().forEach((tr) => tr.stop());
    rolling.slots = []; rolling.canvas = null; rolling.ctx = null; rolling.stream = null;
    clearInterval(rolling.uiTimer);
    els.recBtn.classList.remove('buffering');
  }

  // A rotation changes the view's shape; restart the buffer so the clip keeps one aspect ratio.
  function checkRollingShape() {
    const a = rolling.canvas.width / rolling.canvas.height;
    const b = els.canvas.width / els.canvas.height;
    if (Math.abs(a - b) / b > 0.05) { stopRolling(); startRolling(); }
  }

  function saveClip() {
    if (!rolling.active) { toast('Recording is not available here'); return; }
    if (rolling.saving) return;
    const live = rolling.slots.filter((sl) => sl.rec && sl.rec.state === 'recording').sort((a, b) => a.startedAt - b.startedAt);
    if (!live.length || performance.now() - live[0].startedAt < 800) { toast('Nothing buffered yet'); return; }
    rolling.saving = true;
    els.recLbl.textContent = 'Saving';
    live[0].deliver = true;
    live[0].rec.stop();
  }

  function finishClip(chunks, type) {
    rolling.saving = false;
    if (!chunks.length) { toast('Nothing buffered yet'); return; }
    const ext = type.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
    deliver(new File(chunks, `hologram-${stamp()}.${ext}`, { type }), 'Hologram clip');
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
    if (framed) return;
    els.error.hidden = true;
    els.startBtn.disabled = true;
    pausedByBackground = false;
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
      if (!(err && err.cancelled)) showError(describeError(err));
      els.startBtn.disabled = false;
      return;
    }
    state.t0 = performance.now();
    state.running = true;
    els.start.hidden = true;
    els.hud.hidden = false;
    keepAwake();
    toast('Tap the screen to hide controls', 2600);
    HoloVision.start(els.video);
    startRolling();
  }

  HoloVision.onUpdate(renderVision);
  window.addEventListener('resize', layoutTargets);

  els.startBtn.addEventListener('click', start);
  els.flipBtn.addEventListener('click', flipCamera);
  els.snapBtn.addEventListener('click', capture);
  els.themeBtn.addEventListener('click', () => { state.theme = (state.theme + 1) % THEMES.length; applyTheme(); });
  els.styleBtn.addEventListener('click', () => { state.style = (state.style + 1) % STYLES.length; applyStyle(); });
  els.recBtn.addEventListener('click', saveClip);
  els.fsBtn.addEventListener('click', toggleFullscreen);
  els.canvas.addEventListener('click', () => { if (state.running) document.body.classList.toggle('hud-hidden'); });

  if (!canRecord) els.recBtn.hidden = true;
  if (!fsSupported) els.fsBtn.hidden = true;

  /* ---------------- Stop / background ---------------- */

  let pausedByBackground = false;

  // Turns everything off: camera, recognition, clip buffer, wake lock. Footage is discarded.
  function shutdown(msg) {
    stopRolling();
    HoloVision.stop();
    stopCamera();
    state.running = false;
    pausedByBackground = false;
    smoothRects.clear();
    for (const el of targetEls.values()) el.remove();
    targetEls.clear();
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
    document.body.classList.remove('hud-hidden');
    els.hud.hidden = true;
    els.start.hidden = false;
    els.startBtn.disabled = false;
    if (msg) showError(msg, true);
  }

  function pauseForBackground() {
    if (!state.running || pausedByBackground) return;
    pausedByBackground = true;
    stopRolling();
    HoloVision.stop();
    stopCamera();
  }

  async function resumeFromBackground() {
    pausedByBackground = false;
    try {
      await startCamera({ facingMode: { ideal: state.facing } }, state.facing);
    } catch (err) {
      if (err && err.cancelled) { pausedByBackground = true; return; } // hidden again; wait for the next return
      shutdown('The camera was turned off while the app was in the background. Tap Activate to resume.');
      return;
    }
    HoloVision.start(els.video);
    startRolling();
    keepAwake();
  }

  // Privacy: nothing stays live while the app is off screen. The share sheet is the exception,
  // since it hides the page for a moment.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (!state.sharing) pauseForBackground();
      return;
    }
    if (!state.running) return;
    if (pausedByBackground) { resumeFromBackground(); return; }
    keepAwake();
    els.video.play().catch(() => {});
  });

  els.stopBtn.addEventListener('click', () => shutdown('Camera off. Nothing was kept.'));

  window.addEventListener('keydown', (e) => {
    if (!state.running || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); capture(); }
    else if (e.key === 't' || e.key === 'T') els.themeBtn.click();
    else if (e.key === 's' || e.key === 'S') els.styleBtn.click();
    else if ((e.key === 'r' || e.key === 'R') && !els.recBtn.hidden) els.recBtn.click();
    else if ((e.key === 'f' || e.key === 'F') && !els.flipBtn.hidden) els.flipBtn.click();
    else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('hud-hidden');
    else if (e.key === 'Escape') shutdown('Camera off. Nothing was kept.');
  });

  if (framed) {
    els.startBtn.disabled = true;
    showError('For your safety this app only runs when opened directly, not inside another site. Open the link in your browser.');
  }

  applyTheme();
  applyStyle();
  requestAnimationFrame(loop);

  // Small public surface for tinkering from the console (or automated tests).
  window.HologramAR = {
    start, stop: shutdown, capture, render, state, themes: THEMES, styles: STYLES, fx: FX, vision: HoloVision, saveClip, bufferedSeconds,
    setTheme(i) { state.theme = ((i % THEMES.length) + THEMES.length) % THEMES.length; applyTheme(); },
    setStyle(i) { state.style = ((i % STYLES.length) + STYLES.length) % STYLES.length; applyStyle(); },
  };
})();
