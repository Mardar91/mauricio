// Prueba rápida: tipos de entrada (Blob, File, <img>, <canvas>, ImageBitmap), llamadas simultáneas,
// onProgress y dispose(). Uso: node test/lab/approaches/rectify-rows/tools/smoke-inputs.mjs
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(server.url + '/test/lab/harness.html');
const out = await page.evaluate(async ([impl, photo]) => {
  const mod = await import(impl);
  const blob = await (await fetch(photo)).blob();
  const opts = { tesseract: window.TESS_PATHS };
  const sig = (r) => `${r.layout} ${r.month}/${r.year} ` + r.days.map((d) => d.day + ':' + d.codes.join('+')).join(' ');
  const res = {};
  res.blob = sig(await mod.recognize(blob, opts));
  res.file = sig(await mod.recognize(new File([blob], 'x.jpg', { type: 'image/jpeg' }), opts));
  const img = new Image(); img.src = URL.createObjectURL(blob); await img.decode();
  res.img = sig(await mod.recognize(img, opts));
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
  res.canvas = sig(await mod.recognize(c, opts));
  res.bitmap = sig(await mod.recognize(await createImageBitmap(blob), opts));
  const steps = [];
  const [a, b] = await Promise.all([mod.recognize(blob, { ...opts, onProgress: (f, l) => steps.push(Math.round(f * 100) + ' ' + l) }), mod.recognize(blob, opts)]);
  res.concurrent = sig(a) === sig(b) ? 'iguales' : 'DISTINTOS';
  res.progress = [...new Set(steps.map((s) => s.replace(/^\d+ /, '')))].join(' | ');
  await mod.dispose();
  res.afterDispose = sig(await mod.recognize(blob, opts));
  await mod.dispose();
  return res;
}, [server.url + '/test/lab/approaches/rectify-rows/recognize.js', server.url + '/test/fotos/phone-2026-10-b.jpg']);
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(13), v);
await browser.close(); await server.close();
