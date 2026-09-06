# Vendored dependencies

Everything the scene readout needs is served from this folder so the app makes no
third-party requests at runtime.

| Path | What | Source | Licence |
| --- | --- | --- | --- |
| `tf.es2017.min.js` | TensorFlow.js 4.22.0 (core, converter, CPU and WebGL backends), ES2017 build: no ES5 polyfills, so no string-eval and it runs under a strict Content Security Policy | npm `@tensorflow/tfjs@4.22.0`, `dist/tf.es2017.min.js` | Apache-2.0 |
| `coco-ssd.min.js` | coco-ssd 2.2.3 object-detection wrapper | npm `@tensorflow-models/coco-ssd@2.2.3`, `dist/coco-ssd.min.js` | Apache-2.0 |
| `coco-ssd-lite/` | SSDLite MobileNetV2 COCO detector, weights re-packed as 8-bit | `https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/` | Apache-2.0 |

The weights were quantized from the original float32 files (18 MB) to uint8 with per-tensor
min/scale (4.6 MB) using `tools/quantize-model.mjs`:

```sh
# download model.json and group1-shard1of5 .. 5of5 into ./ssdlite first, then
node tools/quantize-model.mjs ./ssdlite vendor/coco-ssd-lite
```

Detections on test photos match the float32 model to within a few percent.

All of these files are pinned by SHA-384 in `vision.js` (Subresource Integrity for the scripts, an
in-browser hash check for the model files). Print fresh hashes with `node tools/integrity.mjs`.
