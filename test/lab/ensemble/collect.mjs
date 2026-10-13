// Ejecuta los lectores A (phone-a) y B (phone-b) de docs/ sobre cada foto de una verdad de referencia y guarda
// sus resultados en bruto (días con confianza, días no leídos y por qué, mes, avisos, tiempos) para estudiar
// la regla de disparo de B y la fusión sin volver a ejecutar el OCR (ver analyze.mjs).
// Uso: node test/lab/ensemble/collect.mjs --gt <gt.json> [--set dev|holdout|all] --out <salida.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const gtFile = opt('gt', 'test/lab/ground-truth.json');
const set = opt('set', 'all');
const outFile = opt('out', 'test/lab/out/ensemble/collect.json');
const KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];
const GT = JSON.parse(fs.readFileSync(path.resolve(ROOT, gtFile), 'utf8'));
const photos = GT.photos.filter((p) => set === 'all' || p.set === set);

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(server.url + '/test/lab/harness.html');
const out = [];
for (const p of photos) {
  const url = server.url + '/' + (p.file.includes('/') ? p.file : 'test/fotos/' + p.file);
  const r = await page.evaluate(async ([u, known]) => {
    const A = await import('/docs/js/recognize/phone-a/recognize.js');
    const B = await import('/docs/js/recognize/phone-b/recognize.js');
    const blob = await (await fetch(u)).blob();
    const im = new Image(); im.src = URL.createObjectURL(blob); await im.decode();
    const o = { tesseract: window.TESS_PATHS, knownCodes: known };
    const keep = (x) => ({ layout: x.layout, month: x.month, year: x.year, days: x.days, warnings: x.warnings, unread: x.unread || [], unreadWhy: x.unreadWhy || {} });
    let t = performance.now(); const a = await A.recognize(im, o); const msA = performance.now() - t;
    t = performance.now(); const b = await B.recognize(im, o); const msB = performance.now() - t;
    URL.revokeObjectURL(im.src);
    return { a: { ...keep(a), ms: Math.round(msA) }, b: { ...keep(b), ms: Math.round(msB) }, w: im.naturalWidth, h: im.naturalHeight };
  }, [url, KNOWN]);
  out.push({ file: p.file, ...r });
  console.log(`${path.basename(p.file).padEnd(34)} A ${r.a.days.length} días ${r.a.ms} ms · B ${r.b.days.length} días ${r.b.ms} ms`);
}
await browser.close();
await server.close();
fs.writeFileSync(path.resolve(ROOT, outFile), JSON.stringify({ gt: gtFile, set, photos: out }));
console.log(`guardado ${outFile} (${out.length} fotos)`);
