// Generador sintético de fotos de la impresión mensual (réplica HTML/CSS + distorsiones de foto de monitor).
// Uso: node test/lab/approaches/pc-grid/synth/generate.mjs --out <dir> [--n 40] [--seed 1] [--clean 0.15] [--hard 0] [--partial 0]
// Escribe <dir>/<nombre>.jpg y <dir>/gt.json (mismo formato que test/lab/ground-truth.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'pc-grid-synth')));
const N = Number(opt('n', 40)); const SEED = Number(opt('seed', 1)); const CLEAN = Number(opt('clean', 0.15)); const HARD = Number(opt('hard', 0)); const PARTIAL = Number(opt('partial', 0));

function rng(seed) { let s = (seed * 2654435761) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const R = rng(SEED);
const U = (a, b) => a + (b - a) * R();
const I = (a, b) => Math.floor(U(a, b + 1));
const pick = (arr) => arr[Math.floor(R() * arr.length)];

const COMBOS = [
  [['F1', 'F51'], 8], [['F6', 'F52'], 5], [['F3', 'F52'], 3], [['F8', 'F52'], 3], [['F2', 'F51'], 3], [['F1', 'F53'], 2],
  [['S1', 'S51'], 7], [['S1', 'S52'], 6], [['N1', 'N51'], 6], [['Z1', 'S52'], 3], [['Z1', 'F53'], 3],
  [['F1'], 3], [['S1'], 3], [['N1'], 2], [['Z1'], 2], [['F1', 'TS'], 1], [['S1', 'S31'], 1],
  [['F4', 'F54'], 0.4], [['S2', 'S52'], 0.4],
];
const wpick = (list) => { const t = list.reduce((a, [, w]) => a + w, 0); let r = R() * t; for (const [v, w] of list) { if ((r -= w) <= 0) return v; } return list[0][0]; };

function plan(nd) {
  const days = {}; let d = 1;
  while (d <= nd) {
    const r = R();
    if (r < 0.55) { const c = wpick(COMBOS); const n = I(1, 5); for (let i = 0; i < n && d <= nd; i++, d++) days[d] = R() < 0.15 ? wpick(COMBOS) : c; }
    else if (r < 0.85) { const n = I(1, 3); const empty = R() < 0.12; for (let i = 0; i < n && d <= nd; i++, d++) days[d] = empty ? [] : ['-']; }
    else if (r < 0.93) { const n = I(1, 4); for (let i = 0; i < n && d <= nd; i++, d++) days[d] = ['W-']; }
    else { const n = I(2, 7); for (let i = 0; i < n && d <= nd; i++, d++) days[d] = ['U']; }
  }
  return days;
}

const NAMES = ['Müller Anna', 'Schmidt Peter', 'Yilmaz Ayse', 'Kowalski Jan', 'Becker Laura', 'Nowak Ewa', 'Hoffmann Tim', 'Popescu Ana'];

function spec(i) {
  const year = I(2025, 2028); const month = I(1, 12); const nd = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cellW = I(28, 44); const rowH = Math.round(cellW * U(0.6, 0.78));
  const s = {
    cellW, rowH, badgeW: U(0.72, 0.86), badgeH: U(0.66, 0.8), badgeFont: U(0.4, 0.5), headFont: Math.round(rowH * U(0.6, 0.72)), nameFont: Math.round(rowH * U(0.62, 0.72)),
    titleSize: Math.round(rowH * U(1.1, 1.4)), subSize: Math.round(rowH * U(0.55, 0.65)), metaSize: Math.round(rowH * U(0.5, 0.6)),
    nameW: Math.round(cellW * U(3.2, 4.2)), sumW: Math.round(cellW * U(2.2, 3)), marginX: I(40, 80), titleY: I(30, 70), pageX: I(30, 90), pageY: I(15, 50),
    headBg: `rgb(${[0, 0, 0].map(() => I(220, 238)).join(',')})`, nameBg: `rgb(${[0, 0, 0].map(() => I(228, 245)).join(',')})`,
  };
  s.tableW = s.nameW + nd * cellW + 2 * s.sumW;
  s.tableY = s.titleY + Math.round(s.titleSize * 2.45 + s.subSize);
  s.pageW = s.tableW + 2 * s.marginX + 40;
  const nEmp = R() < 0.8 ? 1 : I(2, 4); const target = I(0, nEmp - 1);
  const employees = []; const names = NAMES.slice().sort(() => R() - 0.5);
  for (let e = 0; e < nEmp; e++) employees.push({ name: e === target ? 'Ducuara Mauricio' : names[e], role: 'Pflegekraft', days: plan(nd), soll: `${I(120, 170)},00`, ist: `${I(60, 170)},${pick(['00', '25', '50', '75'])}` });
  const appW = s.pageX + s.pageW + I(20, 120);
  const otherW = R() < 0.6 ? I(120, 320) : 0;
  const screenW = appW + otherW; const screenH = Math.min(1600, s.tableY + 80 + (2 + 3 * nEmp) * (rowH + 1) + I(120, 500));
  const other = [];
  if (otherW) for (let k = 0; k < 30; k++) {
    if (R() < 0.3) other.push({ kind: 'line', x: I(0, otherW), y: I(0, screenH), w: R() < 0.5 ? 1 : I(30, 200), h: R() < 0.5 ? I(30, 300) : 1, color: '#999' });
    else other.push({ kind: 'badge', x: I(0, otherW - 30), y: I(0, screenH - 20), w: I(18, 30), h: I(12, 20), color: pick(['#F2E500', '#E31CE0', '#8DC47E', '#F3B9BF', '#3D63B8']), text: pick(['F1', 'F5', 'S52', 'U', 'S3', 'F7']) });
  }
  const dd = I(1, 28); const pm = month === 1 ? 12 : month - 1; const py = month === 1 ? year - 1 : year;
  const aushang = R() < 0.5 ? `${String(dd).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year} 08:${I(10, 59)}` : `${String(dd).padStart(2, '0')}.${String(pm).padStart(2, '0')}.${py} 1${I(0, 9)}:${I(10, 59)}`;
  return { name: `synth-${SEED}-${String(i).padStart(3, '0')}`, month, year, style: s, employees, target, screenW, screenH, appW, other: otherW ? other : null, aushang };
}

function photoParams(sp, rects, i) {
  const clean = R() < CLEAN;
  const size = clean ? null : HARD ? wpick([[[1600, 900], 3], [[1600, 1200], 2], [[2000, 1500], 2], [[1280, 960], 1], [[1500, 2000], 1], [[4032, 3024], 0.6]])
    : wpick([[[1600, 900], 3], [[1600, 1200], 2], [[2000, 1500], 3], [[1500, 2000], 0.7], [[4032, 3024], 0.6]]);
  const t = rects.table; const ti = rects.title;
  if (clean) {
    // captura limpia: recorte de la pantalla alrededor de la tabla
    const x0 = Math.max(0, ti.x0 - I(10, 80)); const y0 = Math.max(0, ti.y0 - I(10, 60));
    const x1 = Math.min(sp.screenW, t.x1 + I(10, 120)); const y1 = Math.min(sp.screenH, t.y1 + I(20, 300));
    return { clean: true, crop: [x0, y0, x1, y1], quality: U(0.85, 0.95) };
  }
  const [W, H] = size;
  // fracción del ancho de la foto que ocupa la tabla (en vertical la tabla cabe en menos)
  // --partial: tabla más ancha que la foto (solo se ve una parte del mes)
  const frac = PARTIAL ? U(1.4, 2.0) : HARD ? U(0.45, 1.05) : W < H ? U(0.85, 0.98) : U(0.65, 0.97);
  const zoom = (frac * W) / (t.x1 - t.x0);
  const h = HARD;
  return {
    seed: SEED * 1000 + i, W, H, zoom, focusX: PARTIAL ? t.x0 + U(0.2, 0.8) * (t.x1 - t.x0) : (t.x0 + t.x1) / 2, focusY: (ti.y0 + t.y1) / 2,
    offX: U(-0.05, 0.05), offY: U(-0.12, 0.12), rot: U(-1, 1) * (R() < 0.3 ? 15 : 9) * (h ? 1.2 : 1),
    keyX: U(-0.12, 0.12), keyY: U(-0.12, 0.12), jit: [0, 1, 2, 3].map(() => [U(-0.015, 0.015), U(-0.015, 0.015)]),
    bezel: { v: I(10, 50) },
    moire: R() < 0.7 ? { amp: U(0.02, 0.14 + 0.08 * h), per: U(2.2, 5), ang: U(0, Math.PI), per2: U(3, 12), ang2: U(0, Math.PI), chroma: U(0, 0.05) } : { amp: 0, per: 3, ang: 0, per2: 3, ang2: 0, chroma: 0 },
    light: { b0: U(0.55, 1.05), b1: U(0.7, 1.1), dir: U(0, 2 * Math.PI), tint: pick([[1, 1, 1], [1, 0.95, 0.8], [1.02, 0.97, 0.88], [0.92, 0.97, 1.05], [1, 0.9, 0.75]]) },
    glare: R() < 0.35 ? [{ x: U(0.1, 0.9), y: U(0.1, 0.9), rx: U(0.08, 0.3), ry: U(0.05, 0.2), a: U(0.1, 0.45) }] : [],
    blur: R() < 0.6 ? U(0, 0.5) : U(0.5, 1.0 + h), noise: U(0, 6 + 4 * h), quality: U(0.6, 0.92),
    finger: R() < 0.12 ? { x: U(0.2, 0.8), y: U(0.45, 0.8), rx: U(0.03, 0.06), ry: U(0.05, 0.12), ang: U(-0.6, 0.6) } : null,
  };
}

fs.mkdirSync(OUT, { recursive: true });
const server = await startServer(0);
const browser = await chromium.launch();
const ctxs = { 1: await browser.newContext({ deviceScaleFactor: 1 }), 2: await browser.newContext({ deviceScaleFactor: 2 }) };
const pages = {};
for (const k of Object.keys(ctxs)) { pages[k] = await ctxs[k].newPage(); await pages[k].goto(server.url + '/test/lab/approaches/pc-grid/synth/print.html'); }
const gtPath = path.join(OUT, 'gt.json');
const gt = { photos: [] };
for (let i = 0; i < N; i++) {
  const sp = spec(i);
  const dsf = R() < 0.4 ? 2 : 1; const page = pages[dsf];
  await page.setViewportSize({ width: Math.ceil(sp.screenW), height: Math.ceil(sp.screenH) });
  const rects = await page.evaluate((s) => window.buildPrint(s), sp);
  const png = await page.locator('#screen').screenshot({ type: 'png' });
  const scaleRects = (q) => ({ x0: q.x0 * dsf, y0: q.y0 * dsf, x1: q.x1 * dsf, y1: q.y1 * dsf });
  const cellRects = Object.fromEntries(Object.entries(rects.cellRects).map(([d, q]) => [d, scaleRects(q)]));
  const R2 = { table: scaleRects(rects.table), title: scaleRects(rects.title) };
  const pp = photoParams({ ...sp, screenW: sp.screenW * dsf, screenH: sp.screenH * dsf }, R2, i);
  let out;
  if (pp.clean) {
    out = await page.evaluate(async ([url, crop, q, cells]) => {
      const im = new Image(); im.src = url; await im.decode();
      const [x0, y0, x1, y1] = crop; const c = document.createElement('canvas'); c.width = Math.round(x1 - x0); c.height = Math.round(y1 - y0);
      c.getContext('2d').drawImage(im, -x0, -y0);
      const status = {}; for (const [d, r] of Object.entries(cells)) status[d] = r.x0 >= x0 && r.x1 <= x1 && r.y0 >= y0 && r.y1 <= y1 ? 'ok' : 'partial';
      return { jpeg: c.toDataURL('image/jpeg', q), status, titleOk: true };
    }, ['data:image/png;base64,' + png.toString('base64'), pp.crop, pp.quality, cellRects]);
  } else {
    out = await page.evaluate(async ([url, p, cells, title]) => {
      const { distort } = await import('./distort.js');
      return distort(url, p, cells, title);
    }, ['data:image/png;base64,' + png.toString('base64'), pp, cellRects, R2.title]);
  }
  const file = sp.name + '.jpg';
  fs.writeFileSync(path.join(OUT, file), Buffer.from(out.jpeg.split(',')[1], 'base64'));
  const emp = sp.employees[sp.target];
  const days = {}; const optional = {};
  for (const [d, st] of Object.entries(out.status)) {
    if (st === 'ok') days[d] = emp.days[d] || [];
    else if (st !== 'out') optional[d] = null;
  }
  gt.photos.push({ file, layout: 'pc-grid', month: sp.month, year: sp.year, days, optional, set: 'synth', meta: { titleOk: out.titleOk, nEmp: sp.employees.length, dsf, clean: !!pp.clean, rot: pp.rot && +pp.rot.toFixed(1), blur: pp.blur && +pp.blur.toFixed(2), W: pp.W, finger: !!pp.finger } });
  process.stdout.write(`${file} `);
}
fs.writeFileSync(gtPath, JSON.stringify(gt, null, 1));
console.log('\nOK', gtPath);
await browser.close();
await server.close();
