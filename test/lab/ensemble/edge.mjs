// Pruebas de borde del reconocedor de docs/ en Chromium: archivos de vendor que se cargan, tipos de entrada,
// sin OffscreenCanvas, foto de 12 MP, orientación EXIF, progreso, entradas inválidas, dispose() y llamadas
// simultáneas, fotos de 48 MP con el límite de lienzo de iOS simulado y OCR que no arranca.
// Uso: node test/lab/ensemble/edge.mjs [--only nombre] [--impl /ruta/a/index.js]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : ''; };
const only = arg('only');
const IMPL = arg('impl') || '/docs/js/recognize/index.js';
const POOL = IMPL.replace(/index\.js$/, 'ocr-pool.js');
const KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];
const LABELS = ['Leyendo la foto…', 'Buscando los días…', 'Leyendo los turnos…', 'Comprobando…', 'Listo'];
const GT = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/lab/ground-truth.json'), 'utf8')).photos.map((p) => [p.file, p]));

// Servidor estático propio: registra qué archivos de vendor/ se piden (también desde los workers)
const requested = new Set();
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.gz': 'application/gzip', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/hang/')) return; // descarga que nunca responde (red móvil colgada)
  if (p.includes('/vendor/')) requested.add(p);
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

async function openPage({ noOffscreen = false, canvasLimit = false } = {}) {
  const page = await browser.newPage();
  const errors = []; const warns = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); else if (m.type() === 'warning') warns.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
  if (noOffscreen) await page.addInitScript(() => { window.OffscreenCanvas = undefined; });
  // Safari iOS: getContext devuelve null si el lienzo pasa de 16 777 216 px (window.__canvas.on lo activa)
  if (canvasLimit) {
    await page.addInitScript(() => {
      const st = window.__canvas = { on: false, maxArea: 0, maxSide: 0, refused: 0, big: [] };
      for (const C of [window.HTMLCanvasElement, window.OffscreenCanvas]) {
        if (!C || !C.prototype.getContext) continue;
        const orig = C.prototype.getContext;
        C.prototype.getContext = function (...a) {
          if (st.on) {
            const area = this.width * this.height;
            st.maxArea = Math.max(st.maxArea, area); st.maxSide = Math.max(st.maxSide, this.width, this.height);
            if (this.width > 4096 || this.height > 4096) st.big.push(`${this.width}x${this.height}`);
            if (area > 16777216) { st.refused++; return null; }
          }
          return orig.apply(this, a);
        };
      }
    });
  }
  await page.goto(BASE + '/test/lab/harness.html');
  await page.evaluate(([impl, known]) => {
    window.IMPL = impl; window.KNOWN = known; window.POOL = impl.replace(/index\.js$/, 'ocr-pool.js');
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
        case '48mp-vertical': return big(6048, 8064, true);
        case '48mp-horizontal': return big(8064, 6048, true);
        case 'escalada-8064': { const b = await bmp(); const k = 8064 / Math.max(b.width, b.height); return big(Math.round(b.width * k), Math.round(b.height * k), false); }
        case '65mp-vertical': return big(7000, 9334, true);
        case '65mp-horizontal': return big(9334, 7000, true);
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
  return { page, errors, warns };
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
// progreso: fracción creciente, etiquetas conocidas que nunca vuelven atrás y fin en (1, 'Listo')
const progOk = (prog) => prog.length > 1 && prog.every(([f, l], i) => f >= 0 && f <= 1 && LABELS.includes(l)
  && (i === 0 || (f >= prog[i - 1][0] && LABELS.indexOf(l) >= LABELS.indexOf(prog[i - 1][1])))) && prog[prog.length - 1][0] === 1 && prog[prog.length - 1][1] === 'Listo';
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
    const { r, ms, prog } = await page.evaluate(async ([k, u]) => window.run(await window.makeInput(k, u)), [kind, BASE + '/test/fotos/pc-2026-06.jpg']);
    const s = score('pc-2026-06.jpg', r);
    check(`entrada ${kind} (PC)`, s.mal === 0 && s.extra === 0 && r.layout === 'pc-grid' && progOk(prog), fmt(s, ms) + ' ' + JSON.stringify([...new Set(prog.map((x) => x[1]))]));
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
    const pool = await import(window.POOL);
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
  // dispose() cuando A va por los turnos (B forzado): la lectura no lanza B ni el PC, no vuelve a crear
  // workers (época vieja), devuelve 0 días y el pool queda vacío; dispose() tarda < 2 s
  const ep = await page.evaluate(async (u) => {
    const mod = await import(window.IMPL); const pool = await import(window.POOL);
    const input = await window.makeInput('blob', u);
    let tDisp = null; let disposed = null; const after = [];
    const prog = [];
    const r = await mod.recognize(input, {
      tesseract: window.TESS_PATHS, knownCodes: window.KNOWN, phoneB: 'always', debug: true,
      onProgress: (f, l) => {
        prog.push([f, l]);
        if (disposed) after.push(pool.poolInfo());
        if (!disposed && f >= 0.4) { const t0 = performance.now(); disposed = mod.dispose().then(() => { tDisp = Math.round(performance.now() - t0); }); }
      },
    });
    await disposed;
    after.push(pool.poolInfo());
    await new Promise((res) => setTimeout(res, 1500));
    const end = pool.poolInfo();
    return { days: r.days.length, w: r.warnings, ran: r.debug && r.debug.ran, tDisp, end, maxWorkers: Math.max(0, ...after.map((i) => i.workers + (i.creating ? 1 : 0) + i.starting)), prog: prog.slice(-2) };
  }, BASE + '/test/fotos/phone-2026-09-a.jpg');
  check('dispose() durante A: sin B/PC, 0 días, pool vacío y sin workers nuevos', ep.days === 0 && ep.ran && !ep.ran.includes('b') && !ep.ran.includes('pc')
    && ep.end.workers === 0 && !ep.end.creating && ep.end.starting === 0 && ep.maxWorkers === 0 && ep.tDisp < 2000
    && ep.prog[ep.prog.length - 1][0] === 1 && ep.prog[ep.prog.length - 1][1] === 'Listo', JSON.stringify(ep));
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

// 6) Fotos de 48 MP (ProRAW 6048×8064) y de 65 MP con el límite de lienzo de iOS simulado (16 777 216 px):
//    ningún lienzo por encima del límite (ni lado > 4096), mismos días y 0 mal, con B forzado en el móvil
if (want('lienzo')) {
  const { page, errors, warns } = await openPage({ canvasLimit: true });
  const cases = [['phone-2026-07-a.jpg', '48mp-vertical', 'always'], ['phone-2026-09-a.jpg', 'escalada-8064', 'auto'], ['phone-2026-08-b.jpg', '48mp-vertical', 'always'],
    ['pc-2026-06.jpg', '48mp-horizontal', 'auto'], ['phone-2026-07-a.jpg', '65mp-vertical', 'always'], ['pc-2026-06.jpg', '65mp-horizontal', 'auto']];
  for (const [f, kind, b] of cases) {
    const o = await page.evaluate(async ([k, u, b]) => {
      const st = window.__canvas; st.on = false;
      const blob = await window.makeInput(k, u);
      const im = new Image(); im.src = URL.createObjectURL(blob); await im.decode();
      Object.assign(st, { on: true, maxArea: 0, maxSide: 0, refused: 0, big: [] });
      try { const o = await window.run(blob, { opts: { phoneB: b, debug: true } }); return { ...o, size: `${im.naturalWidth}x${im.naturalHeight}`, st: { ...st, big: [...new Set(st.big)].slice(0, 4) } }; } finally { st.on = false; }
    }, [kind, BASE + '/test/fotos/' + f, b]);
    const s = score(f, o.r);
    const ran = o.r.debug && o.r.debug.ran.join('+');
    // ningún lector ha fallado (index.js avisa con console.warn '[recognize] lector …')
    const failedReaders = warns.splice(0).filter((w) => /\[recognize\] lector/.test(w));
    check(`límite de lienzo iOS, ${kind} (${o.size}): ${f}`, s.mal === 0 && s.extra === 0 && s.bien >= s.req - (f.startsWith('pc') ? 1 : 0) && !failedReaders.length && o.st.refused === 0 && o.st.maxArea <= 16777216 && o.st.maxSide <= 4096 && progOk(o.prog),
      `${fmt(s, o.ms)}, lectores ${ran}, lienzo máx ${(o.st.maxArea / 1e6).toFixed(1)} MP / lado ${o.st.maxSide}, rechazados ${o.st.refused}${o.st.big.length ? ' grandes ' + o.st.big.join(',') : ''}${failedReaders.length ? ' ' + failedReaders[0] : ''}`);
  }
  check('límite de lienzo: sin errores en la consola', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// 7) OCR que no arranca (sin conexión la primera vez, descarga colgada): aviso enseguida, nada colgado
if (want('arranque')) {
  const { page, errors } = await openPage();
  const o = await page.evaluate(async ([u, upc]) => {
    const mod = await import(window.IMPL); const pool = await import(window.POOL);
    const input = await window.makeInput('blob', u); const pcInput = await window.makeInput('blob', upc);
    const T = window.TESS_PATHS; const O = location.origin;
    const timed = async (fn, cap = 70000) => {
      const t0 = performance.now();
      const v = await Promise.race([fn(), new Promise((r) => setTimeout(() => r('COLGADO'), cap))]);
      const ms = Math.round(performance.now() - t0);
      if (v === 'COLGADO' || !v || !v.r) return { ms, v: v === 'COLGADO' ? v : 'ok' };
      const last = v.prog[v.prog.length - 1];
      return { ms, layout: v.r.layout, days: v.r.days.length, w: v.r.warnings, ocrFailed: !!v.r.ocrFailed, end: last && last[0] === 1 && last[1] === 'Listo' };
    };
    const out = {};
    await mod.dispose();
    // cuenta los Worker terminados (el worker a medias debe terminarse)
    let term = 0; const t0 = Worker.prototype.terminate;
    Worker.prototype.terminate = function () { term++; return t0.call(this); };
    const lang404 = { ...T, langPath: O + '/no-existe/' };
    out.lang404 = await timed(() => window.run(input, { opts: { tesseract: lang404, ocrStartTimeoutMs: 45000 } }));
    out.pool404 = { ...pool.poolInfo(), terminados: term };
    out.otraFoto = await timed(() => window.run(input, { opts: { tesseract: lang404 } }));
    out.pc404 = await timed(() => window.run(pcInput, { opts: { tesseract: lang404 } }));
    out.dispose404 = await timed(() => mod.dispose());
    out.pc404b = await timed(() => window.run(pcInput, { opts: { tesseract: lang404 } }));
    await mod.dispose();
    out.worker404 = await timed(() => window.run(input, { opts: { tesseract: { ...T, workerPath: O + '/no-existe/worker.min.js' } } }));
    await mod.dispose();
    out.core404 = await timed(() => window.run(input, { opts: { tesseract: { ...T, corePath: O + '/no-existe/' } } }));
    await mod.dispose();
    const hang = { ...T, langPath: O + '/hang/' };
    out.colgada = await timed(() => window.run(input, { opts: { tesseract: hang, ocrStartTimeoutMs: 3000 } }));
    out.poolColgada = pool.poolInfo();
    out.disposeColgada = await timed(() => mod.dispose());
    // dispose() con la descarga colgada y sin tiempo máximo corto: dispose < 2 s y la lectura acaba
    const p = window.run(input, { opts: { tesseract: hang, ocrStartTimeoutMs: 600000 } });
    await new Promise((r) => setTimeout(r, 2500));
    out.poolAntes = pool.poolInfo();
    out.disposeEnCurso = await timed(() => mod.dispose());
    out.lecturaEnCurso = await timed(() => p, 5000);
    out.poolDespues = pool.poolInfo();
    // y luego, con las rutas buenas, se vuelve a leer
    out.despues = await timed(() => window.run(input, { opts: { ocrStartTimeoutMs: 45000 } }));
    return out;
  }, [BASE + '/test/fotos/phone-2026-10-a.jpg', BASE + '/test/fotos/pc-2026-06.jpg']);
  const MSG = 'No se pudo iniciar el lector de texto. Comprueba la conexión a internet y vuelve a intentarlo.';
  const failedOk = (x, maxMs) => x && x.v === undefined && x.days === 0 && x.ocrFailed && x.w[0] === MSG && x.end && x.ms < maxMs;
  const J = (x) => JSON.stringify(x);
  check('idioma 404: aviso de conexión enseguida', failedOk(o.lang404, 8000), J(o.lang404));
  check('idioma 404: pool vacío (worker a medias terminado)', o.pool404.workers === 0 && !o.pool404.creating && o.pool404.starting === 0 && o.pool404.terminados === 1, J(o.pool404));
  check('idioma 404: la foto siguiente no vuelve a esperar', failedOk(o.otraFoto, 500), J(o.otraFoto));
  check('idioma 404: tabla del PC también avisa', failedOk(o.pc404, 500), J(o.pc404));
  check('dispose() tras el fallo < 2 s', o.dispose404.ms < 2000, J(o.dispose404));
  check('idioma 404: tras dispose() se reintenta (y avisa en la tabla del PC)', failedOk(o.pc404b, 8000), J(o.pc404b));
  check('worker 404: aviso de conexión', failedOk(o.worker404, 8000), J(o.worker404));
  check('núcleo 404: aviso de conexión', failedOk(o.core404, 8000), J(o.core404));
  check('descarga colgada: aviso al agotar el tiempo (3 s)', failedOk(o.colgada, 9000) && o.colgada.ms >= 2500, J(o.colgada));
  check('descarga colgada: pool vacío', o.poolColgada.workers === 0 && !o.poolColgada.creating && o.poolColgada.starting === 0, J(o.poolColgada));
  check('dispose() tras la descarga colgada < 2 s', o.disposeColgada.ms < 2000, J(o.disposeColgada));
  check('dispose() con la descarga colgada en curso < 2 s', o.poolAntes.starting > 0 && o.disposeEnCurso.ms < 2000, J({ antes: o.poolAntes, d: o.disposeEnCurso }));
  check('…y la lectura en curso termina (0 días)', o.lecturaEnCurso.v !== 'COLGADO' && o.lecturaEnCurso.days === 0 && o.lecturaEnCurso.end, J(o.lecturaEnCurso));
  check('…y el pool queda vacío', o.poolDespues.workers === 0 && !o.poolDespues.creating && o.poolDespues.starting === 0, J(o.poolDespues));
  check('después, con las rutas buenas, lee bien', o.despues.days > 0 && !o.despues.ocrFailed, J(o.despues));
  // en la consola solo pueden salir los 404 esperados
  const unexpected = errors.filter((e) => !/404|Failed to load resource|ERR_|NetworkError|Network error|importScripts/i.test(e));
  check('arranque: sin otros errores en la consola', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
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
server.closeAllConnections();
server.close();
const vend = [...requested].sort();
console.log('\nArchivos de vendor pedidos:\n  ' + vend.join('\n  '));
const forbidden = vend.filter((p) => /lang\/legacy|tesseract\.esm|core\/tesseract-core(-simd|-relaxedsimd)?\.wasm\.js$/.test(p));
check('no se piden los archivos de vendor que se borran', forbidden.length === 0, forbidden.join(', '));
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} correctas`);
process.exit(fails.length ? 1 : 0);
