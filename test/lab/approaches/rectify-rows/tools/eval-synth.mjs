// Evalúa el reconocedor sobre variantes sintéticas (tools/augment.py) con la verdad de la foto de origen.
// Uso: node test/lab/approaches/rectify-rows/tools/eval-synth.mjs [--dir synth/aug] [--only rot12,dark] [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(HERE, '../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const dir = path.resolve(HERE, opt('dir', 'synth/aug'));
const only = opt('only', '');
const verbose = args.includes('--verbose');
const GT = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/lab/ground-truth.json'), 'utf8'));
let manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
if (only) manifest = manifest.filter((m) => only.split(',').some((s) => m.file.includes(s)));

const same = (a, b) => [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');
const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(server.url + '/test/lab/harness.html');
const impl = server.url + '/test/lab/approaches/rectify-rows/recognize.js';
const byVar = {}; let totMs = 0;
for (const m of manifest) {
  const gt = m.gt || GT.photos.find((p) => p.file === m.source);
  const url = server.url + '/' + path.relative(ROOT, path.join(dir, m.file));
  const { r, ms } = await page.evaluate(async ([i, u]) => {
    const mod = await import(i); const blob = await (await fetch(u)).blob();
    const t = performance.now(); const r = await mod.recognize(blob, { tesseract: window.TESS_PATHS });
    return { r, ms: performance.now() - t };
  }, [impl, url]);
  totMs += ms;
  const s = { req: Object.keys(gt.days).length, ok: 0, wrong: 0, extra: 0, month: r.month === gt.month && r.year === gt.year };
  const bad = [];
  for (const d of r.days) {
    const k = String(d.day);
    if (gt.days[k]) { if (same(d.codes, gt.days[k])) s.ok++; else { s.wrong++; bad.push(`MAL ${k}: ${d.codes} ≠ ${gt.days[k]}`); } }
    else if (k in (gt.optional || {})) { const e = gt.optional[k]; if (e && !same(d.codes, e)) { s.wrong++; bad.push(`OPT ${k}: ${d.codes} ≠ ${e}`); } }
    else { s.extra++; bad.push(`EXTRA ${k}: ${d.codes}`); }
  }
  const v = (byVar[m.variant] ||= { n: 0, req: 0, ok: 0, wrong: 0, extra: 0, month: 0 });
  v.n++; v.req += s.req; v.ok += s.ok; v.wrong += s.wrong; v.extra += s.extra; v.month += s.month ? 1 : 0;
  if (verbose || bad.length) console.log(`${m.file.padEnd(34)} ok ${s.ok}/${s.req} mal ${s.wrong} extra ${s.extra} mes ${s.month ? 'ok' : 'NO'} ${Math.round(ms)}ms ${bad.join(' | ')}`);
}
await browser.close(); await server.close();
let T = { req: 0, ok: 0, wrong: 0, extra: 0 };
for (const [k, v] of Object.entries(byVar)) {
  console.log(`${k.padEnd(10)} ok ${v.ok}/${v.req} (${(100 * v.ok / v.req).toFixed(0)}%) mal ${v.wrong} extra ${v.extra} mes ${v.month}/${v.n}`);
  T.req += v.req; T.ok += v.ok; T.wrong += v.wrong; T.extra += v.extra;
}
console.log(`TOTAL ok ${T.ok}/${T.req} (${(100 * T.ok / T.req).toFixed(1)}%) mal ${T.wrong} extra ${T.extra} media ${Math.round(totMs / manifest.length)}ms`);
