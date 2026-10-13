// Prueba de robustez: perturba fotos de desarrollo y genera capturas sintéticas, y puntúa como eval.mjs.
// Uso: node test/lab/approaches/ocr-first/tools/robust.mjs [--only foto1,foto2] [--variants rot8,blur] [--synth-only] [--no-synth]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const IMPL = 'test/lab/approaches/ocr-first/recognize.js';
const SYNTH = 'test/lab/approaches/ocr-first/tools/synth.js';
const KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];
const GT = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/lab/ground-truth.json'), 'utf8'));
// Solo fotos 'dev' de la lista del móvil (nunca las 'holdout').
const only = String(opt('only', 'phone-2026-08-b,phone-2026-10-a,phone-2026-06-c,phone-2026-09-b,phone-2026-07-a')).split(',');
const photos = GT.photos.filter((p) => p.set === 'dev' && p.layout === 'phone-list' && only.some((o) => p.file.includes(o)));

const VARIANTS = {
  rot8: { rotate: 8 }, rotm12: { rotate: -12 }, rot15: { rotate: 15 },
  big: { scale: 2.4, frame: 0.25 }, yellow: { gain: [1.08, 1.0, 0.68] }, blue: { gain: [0.82, 0.95, 1.15] },
  dark: { gamma: 1.7, contrast: 0.75 }, blur: { blur: 1.4 }, jpeg: { jpeg: 0.45, noise: 18 },
  keystone: { keystone: 0.14 }, glare: { glare: 0.55 },
};
const vsel = opt('variants', '') ? String(opt('variants')).split(',') : Object.keys(VARIANTS);

const SYNTHS = [
  { year: 2026, month: 10, first: 10, rows: [['F1', 'F51'], ['F1', 'F51'], ['F1', 'F52'], ['S1', 'S51'], ['-'], ['S1', 'S31'], ['-'], ['N1', 'N51'], ['N1', 'N51'], ['-'], ['-'], ['F1']] },
  { year: 2026, month: 11, first: 1, rows: [['U'], ['U'], ['Z1'], ['Z1', 'F53'], [], ['W-'], ['W-'], ['F2', 'F52'], ['F3', 'TS'], ['N1'], ['S1', 'S52'], ['-'], ['F8']] },
  { year: 2026, month: 12, first: 18, rows: [['F4', 'F54'], ['S2'], ['-'], ['F6', 'F52'], ['TS'], ['U'], ['U'], [], ['N1', 'N51'], ['S1'], ['W-'], ['F1', 'F51'], ['-'], ['Z1']], offsetY: 60 },
  { year: 2027, month: 1, first: 4, rows: [['F1'], ['F1', 'TS'], ['S1'], ['S1'], ['-'], ['-'], ['N1'], ['N1'], ['N1'], ['-'], ['F6', 'F52'], ['Z1', 'F53']], width: 720, height: 1600, jpeg: 0.7 },
  { year: 2027, month: 2, first: 1, rows: [['F4', 'F54'], ['F4', 'F54'], ['S2', 'S51'], ['TS'], [], ['-'], ['U'], ['N1', 'N51'], ['F2', 'F52'], ['F3', 'F53'], ['F8', 'F51'], ['W-'], ['S31']] },
];

const sameSet = (a, b) => [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');
function score(gt, res) {
  const r = { correct: 0, wrong: [], extra: [], missed: 0, month: res.month === gt.month && res.year === gt.year };
  const by = new Map((res.days || []).map((d) => [d.day, d]));
  for (const [k, exp] of Object.entries(gt.days)) { const d = by.get(+k); if (!d) r.missed++; else if (sameSet(d.codes, exp)) r.correct++; else r.wrong.push(`${k}:${d.codes.join(' ')}≠${exp.join(' ')}`); }
  for (const [day, d] of by) {
    if (gt.days[day]) continue; const o = gt.optional || {};
    if (String(day) in o) { if (o[day] !== null && !sameSet(d.codes, o[day])) r.wrong.push(`opt ${day}:${d.codes.join(' ')}≠${o[day].join(' ')}`); }
    else r.extra.push(`${day}:${d.codes.join(' ')}`);
  }
  return r;
}

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(server.url + '/test/lab/harness.html');
const tot = { req: 0, ok: 0, wrong: 0, extra: 0, month: 0, n: 0, ms: 0 };
const line = (name, gtDays, r, ms) => {
  const req = Object.keys(gtDays).length; tot.req += req; tot.ok += r.correct; tot.wrong += r.wrong.length; tot.extra += r.extra.length; tot.month += r.month ? 1 : 0; tot.n++; tot.ms += ms;
  console.log(`${name.padEnd(34)} mes:${r.month ? 'ok' : 'NO'} ok ${r.correct}/${req} mal ${r.wrong.length} extra ${r.extra.length} ${Math.round(ms)}ms ${[...r.wrong, ...r.extra.map((e) => 'EXTRA ' + e)].join(' | ')}`);
};
if (!opt('synth-only', false)) {
  for (const p of photos) {
    for (const v of vsel) {
      const out = await page.evaluate(async ([impl, synth, photo, t, known]) => {
        const S = await import(synth); const M = await import(impl);
        const blob = await S.transformPhoto(await (await fetch(photo)).blob(), t);
        const t0 = performance.now(); const res = await M.recognize(blob, { tesseract: window.TESS_PATHS, knownCodes: known });
        return { res: { month: res.month, year: res.year, days: res.days }, ms: performance.now() - t0 };
      }, [server.url + '/' + IMPL, server.url + '/' + SYNTH, server.url + '/test/fotos/' + p.file, VARIANTS[v], KNOWN]);
      line(`${p.file.replace('.jpg', '')}+${v}`, p.days, score(p, out.res), out.ms);
    }
  }
}
if (!opt('no-synth', false)) {
  for (const [i, sp] of SYNTHS.entries()) {
    const out = await page.evaluate(async ([impl, synth, spec, known]) => {
      const S = await import(synth); const M = await import(impl);
      const { blob, truth } = await S.renderScreenshot(spec);
      const t0 = performance.now(); const res = await M.recognize(blob, { tesseract: window.TESS_PATHS, knownCodes: known });
      return { truth, res: { month: res.month, year: res.year, days: res.days, warnings: res.warnings }, ms: performance.now() - t0 };
    }, [server.url + '/' + IMPL, server.url + '/' + SYNTH, sp, KNOWN]);
    line(`synth-${i}`, out.truth.days, score(out.truth, out.res), out.ms);
    if (out.res.warnings.length) console.log('    avisos:', out.res.warnings.join(' / '));
  }
}
if (!opt('no-synth', false)) {
  const out = await page.evaluate(async ([impl, synth]) => {
    const S = await import(synth); const M = await import(impl);
    const { blob } = await S.renderNumberedList(12);
    const res = await M.recognize(blob, { tesseract: window.TESS_PATHS });
    return { layout: res.layout, days: res.days.length };
  }, [server.url + '/' + IMPL, server.url + '/' + SYNTH]);
  console.log(`negativo-lista-numerada              layout:${out.layout} días:${out.days} ${out.days ? 'MAL' : 'ok'}`);
  if (out.days) tot.extra += out.days;
}
console.log(`\nROBUSTEZ ok ${tot.ok}/${tot.req} (${(100 * tot.ok / Math.max(1, tot.req)).toFixed(1)}%) mal ${tot.wrong} extra ${tot.extra} mes ${tot.month}/${tot.n} media ${Math.round(tot.ms / Math.max(1, tot.n))}ms`);
await browser.close(); await server.close();
