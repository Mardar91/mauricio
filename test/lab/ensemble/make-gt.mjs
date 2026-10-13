// Genera las verdades derivadas para medir el conjunto (en test/lab/out/ensemble/, fuera de git):
//  - stress-rest-gt.json: stress-gt.json menos las 183 fotos de stress-sample-gt.json (validación de la regla de B)
//  - stress-sample-pcfix-gt.json: la muestra con las variantes de la foto del PC (synth/aug-pc, que allí tienen
//    0 días) con los días reales de pc-2026-06 como opcionales: un día bien no cuenta como "extra" y uno mal sí
//    cuenta como "opt-mal".
// Uso: node test/lab/ensemble/make-gt.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const out = path.join(ROOT, 'test/lab/out/ensemble');
fs.mkdirSync(out, { recursive: true });

const full = rd('test/lab/out/stress-gt.json');
const sample = rd('test/lab/out/stress-sample-gt.json');
const inSample = new Set(sample.photos.map((p) => p.file));
const rest = full.photos.filter((p) => !inSample.has(p.file));
fs.writeFileSync(path.join(out, 'stress-rest-gt.json'), JSON.stringify({ _doc: 'stress-gt.json sin las fotos de stress-sample-gt.json', photos: rest }));

const pc = rd('test/lab/ground-truth.json').photos.find((p) => p.file === 'pc-2026-06.jpg');
let fixed = 0;
const photos = sample.photos.map((p) => {
  if (p.layout !== 'pc-grid' || Object.keys(p.days).length || !/aug-pc\/pc_/.test(p.file)) return p;
  fixed++;
  return { ...p, optional: { ...pc.days, ...(p.optional || {}) } };
});
fs.writeFileSync(path.join(out, 'stress-sample-pcfix-gt.json'), JSON.stringify({ _doc: 'stress-sample-gt.json con los días de pc-2026-06 como opcionales en synth/aug-pc', photos }));
console.log(`resto: ${rest.length} fotos; muestra: ${photos.length} fotos (${fixed} del PC con días opcionales)`);
