// Ejecuta un módulo de experimento en Chromium sobre una o varias imágenes y muestra el JSON del resultado.
// Uso: node test/lab/approaches/pc-grid/tools/run.mjs --impl <ruta módulo> --img <ruta imagen>[,<ruta>...] [--fn recognize] [--opts '{"debug":true}'] [--out dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const impl = opt('impl', 'test/lab/approaches/pc-grid/recognize.js');
const imgs = String(opt('img', 'test/fotos/pc-2026-06.jpg')).split(',');
const fn = opt('fn', 'recognize');
const extra = JSON.parse(opt('opts', '{}'));
const outDir = opt('out', '');
const quiet = args.includes('--quiet');

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (!quiet || m.type() === 'error') console.log('  [browser]', m.type(), m.text().slice(0, 2000)); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(server.url + '/test/lab/harness.html');
for (const img of imgs) {
  const rel = path.relative(ROOT, path.resolve(ROOT, img));
  const res = await page.evaluate(async ([i, f, fname, ex]) => {
    const mod = await import(i);
    const blob = await (await fetch(f)).blob();
    const t0 = performance.now();
    const r = await mod[fname](blob, { tesseract: window.TESS_PATHS, ...ex });
    return { r, ms: performance.now() - t0 };
  }, [server.url + '/' + impl, server.url + '/' + rel, fn, extra]);
  const r = res.r || {};
  let overlay = null;
  if (r.debug && typeof r.debug.overlay === 'string') { overlay = r.debug.overlay; delete r.debug.overlay; }
  console.log(`== ${img} (${Math.round(res.ms)} ms)`);
  console.log(JSON.stringify(r, null, quiet ? 0 : 1).slice(0, 400000));
  if (overlay && outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, path.basename(img).replace(/\.\w+$/, '.png')), Buffer.from(overlay.split(',')[1], 'base64'));
  }
}
await browser.close();
await server.close();
