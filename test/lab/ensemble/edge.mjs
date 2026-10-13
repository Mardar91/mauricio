// Pruebas de borde del reconocedor de docs/ en Chromium: archivos de vendor que se cargan, tipos de entrada,
// sin OffscreenCanvas, foto de 12 MP, orientación EXIF, progreso, entradas inválidas, dispose() y llamadas
// simultáneas. Uso: node test/lab/ensemble/edge.mjs [--only nombre]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : ''; })();
const IMPL = '/docs/js/recognize/index.js';
const KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];
const LABELS = ['Leyendo la foto…', 'Buscando los días…', 'Leyendo los turnos…', 'Comprobando…', 'Listo'];
const GT = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/lab/ground-truth.json'), 'utf8')).photos.map((p) => [p.file, p]));

// Servidor estático propio: registra qué archivos de vendor/ se piden (también desde los workers)
const requested = new Set();
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.gz': 'application/gzip', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.includes('/vendor/')) requested.add(p);
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

async function openPage({ noOffscreen = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
  if (noOffscreen) await page.addInitScript(() => { window.OffscreenCanvas = undefined; });
  await page.goto(BASE + '/test/lab/harness.html');
  await page.evaluate(([impl, known]) => {
    window.IMPL = impl; window.KNOWN = known;
    // Prepara la entrada de un tipo dado a partir de la URL de una foto
    window.makeInput = async (kind, url) => {
      const blob = await (await fetch(url)).blob();
      const bmp = () => createImageBitmap(blob);
      const big = async (W, H, pad) => {
        const b = await bmp(); const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d'); g.fillStyle = '#2b2b2b'; g.fillRect(0, 0, W, H);
        const k = Math.min(W / b.width, H / b.height); const w = b.width * k, h = b.height * k;
        g.imageSmoothingQuality = 'high';
        g.drawImage(b, pad ? (W - w) / 2 : 0, pad ? (H - h) / 2 : 0, w, h);
        return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      };
      switch (kind) {
        case 'blob': return blob;
        case 'file': return new File([blob], 'foto.jpg', { type: blob.type });
        case 'img': { const im = new Image(); im.src = URL.createObjectURL(blob); await im.decode(); return im; }
        case 'img-sin-decodificar': { const im = new Image(); im.src = URL.createObjectURL(blob); return im; }
        case 'canvas': { const b = await bmp(); const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; c.getContext('2d').drawImage(b, 0, 0); return c; }
        case 'bitmap': return bmp();
        case '12mp-vertical': return big(3024, 4032, true);
        case '12mp-horizontal': return big(4032, 3024, true);
        case 'escalada-4032': { const b = await bmp(); const k = 4032 / Math.max(b.width, b.height); return big(Math.round(b.width * k), Math.round(b.height * k), false); }
        default: throw new Error('tipo ' + kind);
      }
    };
    window.run = async (input, extra = {}) => {
      const mod = await import(window.IMPL);
      const prog = [];
      const t0 = performance.now();
      const r = await mod.recognize(input, { tesseract: extra.defaults ? undefined : window.TESS_PATHS, knownCodes: window.KNOWN, onProgress: (f, l) => prog.push([f, l]), ...(extra.opts || {}) });
      return { r, ms: Math.round(performance.now() - t0), prog };
    };
  }, [IMPL, KNOWN]);
  return { page, errors };
}

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? '  ok ' : '  MAL'} ${name}${info ? '  ' + info : ''}`); };
const sameSet = (a, b) => [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');
// Compara con la verdad de referencia: { bien, mal, extra, falta }
function score(file, r) {
  const gt = GT[file]; let bien = 0, mal = 0, extra = 0;
  for (const d of r.days) {
    const req = gt.days[String(d.day)];
    const exp = req || (gt.optional || {})[String(d.day)];
    if (exp === undefined) extra++; else if (exp === null) continue; else if (!sameSet(exp, d.codes)) mal++; else if (req) bien++;
  }
  return { bien, mal, extra, req: Object.keys(gt.days).length, mes: r.month === gt.month && r.year === gt.year };
}
const fmt = (s, ms) => `${s.bien}/${s.req} bien, ${s.mal} mal, ${s.extra} extra, mes ${s.mes ? 'ok' : 'NO'}${ms != null ? `, ${ms} ms` : ''}`;
const progOk = (prog) => prog.length > 1 && prog.every(([f, l], i) => f >= 0 && f <= 1 && LABELS.includes(l) && (i === 0 || f >= prog[i - 1][0])) && prog[prog.length - 1][0] === 1;
const want = (n) => !only || n.includes(only);

// 1) Tipos de entrada (misma foto) → mismos días
if (want('entradas')) {
  const { page, errors } = await openPage();
  const url = BASE + '/test/fotos/phone-2026-10-b.jpg';
  let base = null;
  for (const kind of ['blob', 'file', 'img', 'img-sin-decodificar', 'canvas', 'bitmap']) {
    const { r, ms, prog } = await page.evaluate(async ([k, u]) => window.run(await window.makeInput(k, u)), [kind, url]);
    const s = score('phone-2026-10-b.jpg', r);
    if (!base) base = r;
    const same = JSON.stringify(r.days.map((d) => [d.day, d.codes])) === JSON.stringify(base.days.map((d) => [d.day, d.codes]));
    check(`entrada ${kind}`, s.mal === 0 && s.extra === 0 && same && progOk(prog), fmt(s, ms) + (same ? '' : ' (distinto del Blob)'));
  }
  // la tabla del PC como ImageBitmap y como <canvas>
  for (const kind of ['bitmap', 'canvas']) {
    const { r, ms } = await page.evaluate(async ([k, u]) => window.run(await window.makeInput(k, u)), [kind, BASE + '/test/fotos/pc-2026-06.jpg']);
    const s = score('pc-2026-06.jpg', r);
    check(`entrada ${kind} (PC)`, s.mal === 0 && s.extra === 0 && r.layout === 'pc-grid', fmt(s, ms));
  }
  check('entradas: sin errores en la consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// 2) Sin OffscreenCanvas (como Safari antiguo): 2 fotos, con B forzado para pasar por los tres lectores
if (want('offscreen')) {
  const { page, errors } = await openPage({ noOffscreen: true });
  const hasOff = await page.evaluate(() => typeof OffscreenCanvas);
  check('OffscreenCanvas desactivado', hasOff === 'undefined');
  for (const f of ['phone-2026-08-b.jpg', 'pc-2026-06.jpg']) {
    const { r, ms } = await page.evaluate(async (u) => window.run(await window.makeInput('blob', u), { opts: { phoneB: 'always' } }), BASE + '/test/fotos/' + f);
    const s = score(f, r);
    check(`sin OffscreenCanvas: ${f}`, s.mal === 0 && s.extra === 0 && s.bien === s.req, fmt(s, ms));
  }
  check('sin OffscreenCanvas: sin errores en la consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// 3) Fotos grandes (12 MP) y orientación EXIF
if (want('12mp')) {
  const { page, errors } = await openPage();
  const cases = [['phone-2026-07-a.jpg', '12mp-vertical'], ['phone-2026-09-a.jpg', 'escalada-4032'], ['pc-2026-06.jpg', '12mp-horizontal'], ['pc-2026-06.jpg', 'escalada-4032']];
  for (const [f, kind] of cases) {
    const { r, ms, size } = await page.evaluate(async ([k, u]) => { const b = await window.makeInput(k, u); const o = await window.run(b); return { ...o, size: b.size }; }, [kind, BASE + '/test/fotos/' + f]);
    const s = score(f, r);
    check(`${kind}: ${f}`, s.mal === 0 && s.extra === 0, `${fmt(s, ms)} (${(size / 1e6).toFixed(1)} MB)`);
  }
  const { r, ms } = await page.evaluate(async (u) => window.run(await window.makeInput('blob', u)), BASE + '/test/lab/out/ensemble/exif6-phone-2026-07-a.jpg');
  const s = score('phone-2026-07-a.jpg', r);
  check('EXIF orientación 6 (píxeles girados)', s.mal === 0 && s.extra === 0 && s.bien === s.req, fmt(s, ms));
  check('12 MP: sin errores en la consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// 4) Entradas inválidas, sin Tesseract, dispose(), rutas por defecto y llamadas simultáneas
if (want('robustez')) {
  const { page, errors } = await openPage();
  const bad = await page.evaluate(async () => {
    const out = {};
    const mk1 = () => { const c = document.createElement('canvas'); c.width = 1; c.height = 1; return c; };
    const cases = { null: null, undefined, vacio: new Blob([]), texto: new Blob(['hola'], { type: 'text/plain' }), objeto: {}, 'canvas-1px': mk1() };
    for (const [k, v] of Object.entries(cases)) {
      try { const { r } = await window.run(v); out[k] = r; } catch (e) { out[k] = 'LANZA ' + e.message; }
    }
    return out;
  });
  for (const [k, r] of Object.entries(bad)) check(`entrada inválida (${k}) no lanza`, typeof r === 'object' && r.layout === 'unknown' && r.days.length === 0 && r.warnings.length > 0, typeof r === 'object' ? r.warnings[0] : r);
  const noT = await page.evaluate(async (u) => {
    const T = window.Tesseract; delete window.Tesseract;
    try { return (await window.run(await window.makeInput('blob', u))).r; } finally { window.Tesseract = T; }
  }, BASE + '/test/fotos/phone-2026-10-a.jpg');
  check('sin Tesseract: aviso, no lanza', noT.days.length === 0 && noT.warnings.length > 0, noT.warnings[0]);
  // dispose: termina los workers; después se puede volver a leer (rutas por defecto, sin options.tesseract)
  const d = await page.evaluate(async (u) => {
    const pool = await import('/docs/js/recognize/ocr-pool.js');
    const mod = await import(window.IMPL);
    await window.run(await window.makeInput('blob', u));
    const before = pool.poolInfo().workers;
    await mod.dispose();
    const after = pool.poolInfo().workers;
    const again = await window.run(await window.makeInput('blob', u), { defaults: true });
    const third = pool.poolInfo().workers;
    await mod.dispose(); await mod.dispose(); // dos veces seguidas: no falla
    return { before, after, third, days: again.r.days.length };
  }, BASE + '/test/fotos/phone-2026-10-a.jpg');
  check('dispose() termina los workers y se puede volver a leer', d.before >= 1 && d.after === 0 && d.third >= 1 && d.days > 0, JSON.stringify(d));
  // dispose() a mitad de una lectura: la lectura termina (sin colgarse) y la siguiente funciona
  const mid = await page.evaluate(async (u) => {
    const mod = await import(window.IMPL);
    const input = await window.makeInput('blob', u);
    const p = window.run(input, { opts: { phoneB: 'always' } });
    await new Promise((r) => setTimeout(r, 900));
    await mod.dispose();
    const timeout = new Promise((r) => setTimeout(() => r('COLGADO'), 30000));
    const first = await Promise.race([p, timeout]);
    const next = await window.run(input);
    return { first: first === 'COLGADO' ? first : { days: first.r.days.length, w: first.r.warnings }, next: next.r.days.length };
  }, BASE + '/test/fotos/phone-2026-09-a.jpg');
  check('dispose() durante una lectura: no se cuelga', mid.first !== 'COLGADO' && mid.next > 0, JSON.stringify(mid));
  // dos lecturas a la vez (comparten el worker): ningún día mal
  const two = await page.evaluate(async ([u1, u2]) => {
    const [a, b] = await Promise.all([window.run(await window.makeInput('blob', u1)), window.run(await window.makeInput('blob', u2))]);
    return [a.r, b.r];
  }, [BASE + '/test/fotos/phone-2026-06-a.jpg', BASE + '/test/fotos/pc-2026-06.jpg']);
  const s1 = score('phone-2026-06-a.jpg', two[0]); const s2 = score('pc-2026-06.jpg', two[1]);
  check('dos lecturas simultáneas', s1.mal + s1.extra + s2.mal + s2.extra === 0, `${fmt(s1)} | ${fmt(s2)}`);
  check('robustez: sin errores en la consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// 5) Núcleos de Tesseract que cargarán otros navegadores (Safari 16.4: SIMD sin relaxed; antiguos: sin SIMD)
if (want('nucleos')) {
  const { page, errors } = await openPage();
  for (const core of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
    const { r, ms } = await page.evaluate(async ([u, c]) => {
      const mod = await import(window.IMPL); await mod.dispose();
      return window.run(await window.makeInput('blob', u), { opts: { tesseract: { ...window.TESS_PATHS, corePath: window.TESS_PATHS.corePath + c } } });
    }, [BASE + '/test/fotos/phone-2026-08-a.jpg', core]);
    const s = score('phone-2026-08-a.jpg', r);
    check(`núcleo ${core}`, s.mal === 0 && s.extra === 0 && s.bien === s.req, fmt(s, ms));
  }
  check('núcleos: sin errores en la consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

await browser.close();
server.close();
const vend = [...requested].sort();
console.log('\nArchivos de vendor pedidos:\n  ' + vend.join('\n  '));
const forbidden = vend.filter((p) => /lang\/legacy|tesseract\.esm|core\/tesseract-core(-simd|-relaxedsimd)?\.wasm\.js$/.test(p));
check('no se piden los archivos de vendor que se borran', forbidden.length === 0, forbidden.join(', '));
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} correctas`);
process.exit(fails.length ? 1 : 0);
