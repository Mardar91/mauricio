// Ejecuta el reconocedor rectify-rows sobre fotos de desarrollo y guarda overlays + JSON de depuración.
// Uso: node test/lab/approaches/rectify-rows/tools/dev.mjs [--only a,b] [--out dir] [--opts '{"skipOcr":true}']
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', '');
const out = opt('out', process.env.RR_OUT || '/tmp/rr-dev');
const extra = JSON.parse(opt('opts', '{}'));
const files = (opt('files', '') || '').split(',').filter(Boolean);
fs.mkdirSync(out, { recursive: true });

const GT = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/lab/ground-truth.json'), 'utf8'));
let photos = GT.photos.filter((p) => p.set === 'dev' && (!only || only.split(',').some((s) => p.file.includes(s)))).map((p) => p.file);
if (files.length) photos = files; // rutas absolutas o relativas a la raíz (p. ej. sintéticas)

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('  [browser]', m.type(), m.text().slice(0, 400)));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(server.url + '/test/lab/harness.html');
const impl = server.url + '/test/lab/approaches/rectify-rows/recognize.js';

for (const f of photos) {
  const url = f.includes('/') ? server.url + '/' + path.relative(ROOT, path.resolve(ROOT, f)) : server.url + '/test/fotos/' + f;
  const t0 = Date.now();
  const res = await page.evaluate(async ([i, u, x]) => {
    const mod = await import(i);
    const blob = await (await fetch(u)).blob();
    const t = performance.now();
    const r = await mod.recognize(blob, { tesseract: window.TESS_PATHS, debug: true, ...x });
    return { r, ms: performance.now() - t };
  }, [impl, url, extra]);
  const base = path.basename(f).replace(/\.\w+$/, '');
  const dbg = res.r.debug || {};
  if (typeof dbg.overlay === 'string') fs.writeFileSync(path.join(out, base + '.png'), Buffer.from(dbg.overlay.split(',')[1], 'base64'));
  for (const [k, v] of Object.entries(dbg)) if (typeof v === 'string' && v.startsWith('data:image') && k !== 'overlay') fs.writeFileSync(path.join(out, base + '.' + k + '.png'), Buffer.from(v.split(',')[1], 'base64'));
  const slim = { ...res.r, debug: Object.fromEntries(Object.entries(dbg).filter(([, v]) => !(typeof v === 'string' && v.startsWith('data:')))) };
  fs.writeFileSync(path.join(out, base + '.json'), JSON.stringify(slim, null, 1));
  const gt = GT.photos.find((p) => p.file === path.basename(f));
  console.log(`${base}: ${Math.round(res.ms)}ms layout=${res.r.layout} ${res.r.month}/${res.r.year} days=${res.r.days.map((d) => d.day + ':' + d.codes.join('+')).join(' ')}`);
  if (gt) console.log(`   GT: ${Object.entries(gt.days).map(([d, c]) => d + ':' + c.join('+')).join(' ')}`);
  if (res.r.warnings?.length) console.log('   warn:', res.r.warnings.join(' | '));
  void t0;
}
await browser.close(); await server.close();
