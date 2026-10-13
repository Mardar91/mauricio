// Pruebas de casos límite en Chromium (solo desarrollo).
// Uso: node test/lab/approaches/color-first/tools/edge-tests.mjs
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const server = await startServer(0);
const browser = await chromium.launch();
const impl = server.url + '/test/lab/approaches/color-first/recognize.js';
const photo = server.url + '/test/fotos/phone-2026-07-b.jpg';
const summary = (r) => `${r.layout} ${r.month}/${r.year} días=${r.days.length} [${r.days.map((d) => d.day + ':' + d.codes.join('+')).join(' ')}] avisos=${JSON.stringify(r.warnings)}`;

async function runIn(noOffscreen, fn) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(server.url + '/test/lab/harness.html');
  if (noOffscreen) await page.evaluate(() => { window.OffscreenCanvas = undefined; });
  const out = await page.evaluate(fn, [impl, photo]);
  await page.close();
  return out;
}

const cases = {
  'blob': async ([i, f]) => { const m = await import(i); const b = await (await fetch(f)).blob(); return await m.recognize(b, { tesseract: window.TESS_PATHS }); },
  'canvas': async ([i, f]) => { const m = await import(i); const b = await (await fetch(f)).blob(); const bmp = await createImageBitmap(b); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); return await m.recognize(c, { tesseract: window.TESS_PATHS }); },
  'imagebitmap': async ([i, f]) => { const m = await import(i); const b = await (await fetch(f)).blob(); return await m.recognize(await createImageBitmap(b), { tesseract: window.TESS_PATHS }); },
  'img': async ([i, f]) => { const m = await import(i); const img = new Image(); img.src = f; await img.decode(); return await m.recognize(img, { tesseract: window.TESS_PATHS }); },
  'no-imagen': async ([i]) => { const m = await import(i); return await m.recognize(new Blob(['hola'], { type: 'text/plain' }), { tesseract: window.TESS_PATHS }); },
  'blanca': async ([i]) => { const m = await import(i); const c = document.createElement('canvas'); c.width = 900; c.height = 1600; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 1600); return await m.recognize(c, { tesseract: window.TESS_PATHS }); },
  'sin-tesseract-paths': async ([i, f]) => { const m = await import(i); const b = await (await fetch(f)).blob(); return await m.recognize(b, {}); },
  'dispose+otra vez': async ([i, f]) => { const m = await import(i); const b = await (await fetch(f)).blob(); await m.recognize(b, { tesseract: window.TESS_PATHS }); await m.dispose(); const p = []; const r = await m.recognize(b, { tesseract: window.TESS_PATHS, onProgress: (x, l) => p.push(Math.round(x * 100) + ' ' + l) }); r.warnings.push('progreso: ' + p.join(', ')); return r; },
};
for (const [name, fn] of Object.entries(cases)) {
  for (const noOff of name === 'blob' || name === 'canvas' ? [false, true] : [false]) {
    const t = Date.now();
    try { const r = await runIn(noOff, fn); console.log(`${name}${noOff ? ' (sin OffscreenCanvas)' : ''}: ${summary(r)} ${Date.now() - t}ms`); }
    catch (e) { console.log(`${name}: EXCEPCIÓN ${String(e).slice(0, 200)}`); }
  }
}
await browser.close(); await server.close();
