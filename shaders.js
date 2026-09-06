/* GLSL sources for the hologram pipeline.
 *
 * Pipeline per frame:
 *   1. prep      camera -> half-res, box-filtered luminance (kills sensor noise before edge detection)
 *   2. holo      luminance -> edges + fill, blended with last frame for persistence, as (holo, edge, fill)
 *   3. down      holo -> quarter-res, soft-thresholded copy for the glow
 *   4. blur x2   separable gaussian on the quarter-res glow
 *   5. composite holo + glow + camera -> tint, scanlines, glitch, grain, flicker, vignette
 */
(function () {
  'use strict';

  const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

  // Maps screen UV to camera UV: "cover" crop, vertical flip (video rows are
  // top-down), optional horizontal mirror for the selfie camera.
  const VIDEO_UV = `
uniform vec2 uCover;
uniform float uMirror;
vec2 videoUv(vec2 uv) {
  vec2 p = (uv - 0.5) * uCover + 0.5;
  p.y = 1.0 - p.y;
  p.x = mix(p.x, 1.0 - p.x, uMirror);
  return p;
}
`;

  const vert = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

  const prep = PRECISION + `
varying vec2 vUv;
uniform sampler2D uVideo;
uniform vec2 uTexel;
float luma(vec2 p) {
  vec3 c = texture2D(uVideo, p).rgb;
  return dot(c, vec3(0.299, 0.587, 0.114));
}
void main() {
  // Rendered at half the camera resolution: four bilinear taps = a 4x4 box filter.
  float l = luma(vUv + uTexel * vec2(-1.0, -1.0))
          + luma(vUv + uTexel * vec2( 1.0, -1.0))
          + luma(vUv + uTexel * vec2(-1.0,  1.0))
          + luma(vUv + uTexel * vec2( 1.0,  1.0));
  gl_FragColor = vec4(l * 0.25, 0.0, 0.0, 1.0);
}
`;

  const holo = PRECISION + `
varying vec2 vUv;
uniform sampler2D uLuma;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uEdgeGain;
uniform float uFillAmt;
uniform float uEdgeAmt;
uniform float uContour;
uniform float uPersist;
` + VIDEO_UV + `
float luma(vec2 p) { return texture2D(uLuma, p).r; }
void main() {
  vec2 p = videoUv(vUv);
  vec2 t = uTexel;
  float tl = luma(p + vec2(-t.x,  t.y));
  float tc = luma(p + vec2( 0.0,  t.y));
  float tr = luma(p + vec2( t.x,  t.y));
  float ml = luma(p + vec2(-t.x,  0.0));
  float mc = luma(p);
  float mr = luma(p + vec2( t.x,  0.0));
  float bl = luma(p + vec2(-t.x, -t.y));
  float bc = luma(p + vec2( 0.0, -t.y));
  float br = luma(p + vec2( t.x, -t.y));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  float edge = smoothstep(0.08, 0.6, length(vec2(gx, gy)) * uEdgeGain);

  float fill = pow(smoothstep(0.02, 1.0, mc), 1.15);
  // Contour lines at luminance steps: a "3D scan" look.
  float bands = abs(fract(fill * 7.0 + 0.5) - 0.5);
  float contour = (1.0 - smoothstep(0.0, 0.08, bands)) * smoothstep(0.03, 0.2, fill) * uContour;

  float holo = fill * uFillAmt + edge * uEdgeAmt + contour * 0.5;
  vec4 now = vec4(holo, max(edge, contour * 0.5), fill, 1.0);
  // Persistence: a little of the previous frame lingers, like a slow phosphor.
  gl_FragColor = mix(texture2D(uPrev, vUv), now, uPersist);
}
`;

  const down = PRECISION + `
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
  vec4 s = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0))
         + texture2D(uTex, vUv + uTexel * vec2( 1.0, -1.0))
         + texture2D(uTex, vUv + uTexel * vec2(-1.0,  1.0))
         + texture2D(uTex, vUv + uTexel * vec2( 1.0,  1.0));
  float v = s.r * 0.25;
  v *= smoothstep(0.02, 0.4, v);
  gl_FragColor = vec4(v, v, v, 1.0);
}
`;

  const blur = PRECISION + `
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec4 c = texture2D(uTex, vUv) * 0.2270270270;
  c += texture2D(uTex, vUv + uDir * 1.3846153846) * 0.3162162162;
  c += texture2D(uTex, vUv - uDir * 1.3846153846) * 0.3162162162;
  c += texture2D(uTex, vUv + uDir * 3.2307692308) * 0.0702702703;
  c += texture2D(uTex, vUv - uDir * 3.2307692308) * 0.0702702703;
  gl_FragColor = c;
}
`;

  const composite = PRECISION + `
varying vec2 vUv;
uniform sampler2D uHolo;
uniform sampler2D uBloom;
uniform sampler2D uVideo;
uniform vec2  uRes;
uniform float uTime;
uniform vec3  uTint;
uniform vec3  uEdgeTint;
uniform float uSpectrum;
uniform float uRealMix;
uniform float uBloomAmt;
uniform float uGlitch;
uniform float uAberr;
uniform float uScanPx;
uniform float uNoise;
` + VIDEO_UV + `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
vec3 tintFor(float fill) {
  vec3 spec = hsv2rgb(vec3(fract(0.66 - fill * 0.66 + uTime * 0.02), 0.9, 1.0));
  return mix(uTint, spec, uSpectrum);
}
vec3 shade(vec4 h, vec3 tint) {
  return tint * h.r + uEdgeTint * h.g * 0.35;
}
void main() {
  float t = uTime;
  vec2 uv = vUv;

  // Glitch bursts: short windows where horizontal slices tear sideways.
  float slot = floor(t * 3.0);
  float burst = step(1.0 - 0.14 * uGlitch, hash11(slot + 11.0));
  float sliceN = 14.0 + 40.0 * hash11(slot + 5.0);
  float slice = floor(uv.y * sliceN);
  float r = hash21(vec2(slice, floor(t * 16.0)));
  uv.x += (r - 0.5) * 0.16 * step(0.6, r) * burst;
  uv.y += (hash11(floor(t * 8.0)) - 0.5) * 0.012 * burst;

  // Gentle horizontal wobble, like a projector that is not quite stable.
  uv.x += sin(uv.y * 28.0 + t * 1.6) * 0.0012 + sin(uv.y * 95.0 - t * 2.9) * 0.0005;

  // Chromatic aberration: sample the hologram at three horizontal offsets.
  vec2 off = vec2(uAberr * (1.0 + 3.0 * burst), 0.0);
  vec4 hL = texture2D(uHolo, uv + off);
  vec4 hC = texture2D(uHolo, uv);
  vec4 hR = texture2D(uHolo, uv - off);
  vec3 tint = tintFor(hC.b);
  vec3 col = vec3(shade(hL, tint).r, shade(hC, tint).g, shade(hR, tint).b);

  // Glow.
  col += tint * texture2D(uBloom, uv).r * uBloomAmt;

  // Ghost style: let some of the real camera colour back through.
  vec3 real = texture2D(uVideo, videoUv(uv)).rgb;
  col = mix(col, real * 0.55 + col * 0.75, uRealMix);

  // Scanlines that slowly crawl.
  float scan = 0.5 + 0.5 * sin((uv.y * uRes.y / uScanPx) * 6.2831853 + t * 3.0);
  col *= mix(0.7, 1.0, scan);

  // A wide, faint band rolling through the image.
  float band = fract(uv.y * 0.7 - t * 0.06);
  float roll = smoothstep(0.0, 0.12, band) * smoothstep(0.32, 0.12, band);
  col *= 1.0 + roll * 0.22;

  // Random dropout rows.
  float rowId = floor(vUv.y * uRes.y * 0.5);
  float drop = step(0.992, hash21(vec2(rowId, floor(t * 4.0))));
  col *= 1.0 - drop * 0.6;

  // Grain.
  col += (hash21(vUv * uRes + fract(t * 7.0) * 371.0) - 0.5) * uNoise;

  // Flicker, stronger during glitch bursts.
  float flick = 0.94 + 0.06 * hash11(floor(t * 24.0));
  flick *= 1.0 - 0.15 * burst;
  col *= flick;

  // Vignette.
  float vig = 1.0 - smoothstep(0.55, 1.35, length(vUv - 0.5) * 1.6);
  col *= vig;

  // Soft tonemap, plus a whisper of the tint in the blacks.
  col = 1.0 - exp(-col * 1.7);
  col += uTint * 0.02;
  gl_FragColor = vec4(col, 1.0);
}
`;

  window.HOLO_SHADERS = { vert, prep, holo, down, blur, composite };
})();
