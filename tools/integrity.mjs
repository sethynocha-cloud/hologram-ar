// Prints the SHA-384 integrity strings pinned in vision.js for the vendored detector files.
// Run after changing anything under vendor/ and paste the values into SCRIPTS / MODEL_FILES.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'vendor/tf.es2017.min.js',
  'vendor/coco-ssd.min.js',
  'vendor/coco-ssd-lite/model.json',
  'vendor/coco-ssd-lite/group1-shard1of2.bin',
  'vendor/coco-ssd-lite/group1-shard2of2.bin',
];
for (const f of files) {
  const hash = createHash('sha384').update(fs.readFileSync(path.join(root, f))).digest('base64');
  console.log(`${f}\n  sha384-${hash}`);
}
