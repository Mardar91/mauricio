// Herramienta de exploración: ejecuta una función exportada de un módulo en Chromium sobre una foto.
// Uso: node tools/probe.mjs <modulo.js relativo a la raíz> <funcion> <foto> [outDir] [jsonArg]
// La función recibe (blob, {tesseract, arg}) y devuelve {images?: {nombre: dataURL}, data?: any}.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const [mod, fn, photo, outDir = '/tmp/probe', arg = 'null'] = process.argv.slice(2);
const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('  [browser]', m.type(), m.text().slice(0, 500)));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(server.url + '/test/lab/harness.html');
fs.mkdirSync(outDir, { recursive: true });
for (const ph of photo.split(',')) {
  const t0 = Date.now();
  const res = await page.evaluate(async ([m, f, p, a]) => {
    const M = await import(m);
    const blob = await (await fetch(p)).blob();
    return M[f](blob, { tesseract: window.TESS_PATHS, arg: a });
  }, [server.url + '/' + mod, fn, server.url + '/test/fotos/' + ph, JSON.parse(arg)]);
  console.log(`== ${ph} (${Date.now() - t0} ms)`);
  for (const [name, url] of Object.entries(res.images || {})) {
    const f = path.join(outDir, ph.replace(/\.jpg$/, '') + '_' + name + '.png');
    fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
    console.log('  img', f);
  }
  if (res.data !== undefined) console.log(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 0).slice(0, 20000));
}
await browser.close();
await server.close();
