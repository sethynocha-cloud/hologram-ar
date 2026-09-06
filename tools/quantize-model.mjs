// Re-packs a TF.js graph model with uint8-quantized float32 weights (per-tensor affine
// min/scale, the same scheme tensorflowjs_converter --quantize_uint8 uses).
import fs from 'node:fs';
import path from 'node:path';

const [,, srcDir, outDir, minElemsArg] = process.argv;
const MIN_ELEMS = Number(minElemsArg || 1024);
const SHARD_BYTES = 4 * 1024 * 1024;
const model = JSON.parse(fs.readFileSync(path.join(srcDir, 'model.json'), 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const DT = { float32: 4, int32: 4, bool: 1, uint8: 1, uint16: 2 };
let totalIn = 0, totalOut = 0, quantized = 0, kept = 0;

model.weightsManifest = model.weightsManifest.map((group, gi) => {
  const buf = Buffer.concat(group.paths.map((p) => fs.readFileSync(path.join(srcDir, p))));
  totalIn += buf.length;
  const out = [];
  let off = 0;
  const weights = group.weights.map((w) => {
    const n = w.shape.reduce((a, b) => a * b, 1);
    const bytes = n * DT[w.dtype];
    const raw = buf.subarray(off, off + bytes);
    off += bytes;
    if (w.dtype !== 'float32' || n < MIN_ELEMS || w.quantization) {
      out.push(Buffer.from(raw)); kept++;
      return w;
    }
    const f = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + bytes));
    let min = Infinity, max = -Infinity;
    for (const v of f) { if (v < min) min = v; if (v > max) max = v; }
    let scale = (max - min) / 255;
    if (scale === 0) scale = 1;
    const q = Buffer.alloc(n);
    for (let i = 0; i < n; i++) q[i] = Math.min(255, Math.max(0, Math.round((f[i] - min) / scale)));
    out.push(q); quantized++;
    return Object.assign({}, w, { quantization: { dtype: 'uint8', min, scale } });
  });
  if (off !== buf.length) throw new Error(`group ${gi}: consumed ${off} of ${buf.length} bytes`);
  const all = Buffer.concat(out);
  totalOut += all.length;
  const paths = [];
  const count = Math.ceil(all.length / SHARD_BYTES);
  for (let i = 0; i < count; i++) {
    const name = `group${gi + 1}-shard${i + 1}of${count}.bin`;
    fs.writeFileSync(path.join(outDir, name), all.subarray(i * SHARD_BYTES, (i + 1) * SHARD_BYTES));
    paths.push(name);
  }
  return { paths, weights };
});

fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model));
console.log(`weights: ${quantized} quantized, ${kept} kept; bytes ${totalIn} -> ${totalOut} (${(totalOut / totalIn * 100).toFixed(1)}%)`);
