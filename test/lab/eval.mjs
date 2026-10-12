// Evalúa un reconocedor contra test/lab/ground-truth.json usando Chromium (Playwright).
//
// Uso:
//   node test/lab/eval.mjs --impl docs/js/recognize/index.js [--only phone-2026-08] [--debug] [--verbose] [--json out.json]
//
// --impl    ruta (desde la raíz del repo) al módulo ES que exporta recognize(input, options)
// --only    filtra fotos cuyo nombre contiene este texto (se puede repetir separado por comas)
// --debug   pasa debug:true; si result.debug.overlay es un dataURL PNG/JPEG se guarda en test/lab/out/<impl>/<foto>.png
// --verbose imprime los días de cada foto
// --json    escribe el informe completo en este archivo
// --set     dev (por defecto) | holdout | all. Las fotos 'holdout' NO se usan durante el desarrollo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const impl = opt('impl', 'docs/js/recognize/index.js');
const only = opt('only', '');
const debug = !!opt('debug', false);
const verbose = !!opt('verbose', false);
const jsonOut = opt('json', '');
const set = opt('set', 'dev'); // dev | holdout | all

const GT = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/lab/ground-truth.json'), 'utf8'));
const KNOWN = ['F1','F2','F3','F6','F8','S1','N1','Z1','F51','F52','F53','S51','S52','N51','S31','TS','W-','U','-'];
const photos = GT.photos.filter((p) => (set === 'all' || p.set === set) && (!only || String(only).split(',').some((s) => p.file.includes(s))));

const sameSet = (a, b) => { const A = [...new Set(a)].sort().join('|'); const B = [...new Set(b)].sort().join('|'); return A === B; };

function score(gt, result) {
  const rep = { file: gt.file, layoutOk: result.layout === gt.layout, monthOk: result.month === gt.month && result.year === gt.year,
    got: { layout: result.layout, month: result.month, year: result.year }, correct: [], wrong: [], missed: [], extra: [], optionalOk: [], optionalWrong: [] };
  const byDay = new Map();
  for (const d of result.days || []) {
    if (byDay.has(d.day)) rep.wrong.push({ day: d.day, expected: 'único', got: d.codes, why: 'día duplicado' });
    byDay.set(d.day, d);
  }
  for (const [k, exp] of Object.entries(gt.days)) {
    const day = Number(k); const r = byDay.get(day);
    if (!r) rep.missed.push({ day, expected: exp });
    else if (sameSet(r.codes, exp)) rep.correct.push({ day, codes: r.codes, conf: r.confidence });
    else rep.wrong.push({ day, expected: exp, got: r.codes, conf: r.confidence });
  }
  for (const [day, r] of byDay) {
    if (gt.days[String(day)]) continue;
    if (String(day) in (gt.optional || {})) {
      const exp = gt.optional[String(day)];
      if (exp === null) continue;
      if (sameSet(r.codes, exp)) rep.optionalOk.push({ day, codes: r.codes });
      else rep.optionalWrong.push({ day, expected: exp, got: r.codes, conf: r.confidence });
    } else rep.extra.push({ day, got: r.codes, conf: r.confidence });
  }
  return rep;
}

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (verbose || m.type() === 'error') console.log('  [browser]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto(server.url + '/test/lab/harness.html');

const reports = [];
const outDir = path.join(ROOT, 'test/lab/out', impl.replace(/[\\/]/g, '_'));
if (debug) fs.mkdirSync(outDir, { recursive: true });

for (const p of photos) {
  let rep;
  try {
    const { result, ms } = await page.evaluate(([i, f, d, k]) => window.runRecognizer(i, f, { debug: d, knownCodes: k }),
      [server.url + '/' + impl, server.url + '/test/fotos/' + p.file, debug, KNOWN]);
    rep = score(p, result); rep.ms = Math.round(ms); rep.warnings = result.warnings || [];
    if (debug && result.debug && typeof result.debug.overlay === 'string' && result.debug.overlay.startsWith('data:image')) {
      const b64 = result.debug.overlay.split(',')[1];
      fs.writeFileSync(path.join(outDir, p.file.replace(/\.jpg$/, '.png')), Buffer.from(b64, 'base64'));
    }
  } catch (e) {
    rep = { file: p.file, error: String(e.message || e).slice(0, 500), correct: [], wrong: [], missed: Object.entries(p.days).map(([d, c]) => ({ day: +d, expected: c })), extra: [], optionalOk: [], optionalWrong: [] };
  }
  reports.push(rep);
  const req = Object.keys(p.days).length;
  console.log(`${p.file.padEnd(22)} ${rep.error ? 'ERROR ' + rep.error : `layout:${rep.layoutOk ? 'ok' : 'NO(' + rep.got.layout + ')'} mes:${rep.monthOk ? 'ok' : 'NO(' + rep.got.month + '/' + rep.got.year + ')'} ok ${rep.correct.length}/${req}  mal ${rep.wrong.length}  extra ${rep.extra.length}  falta ${rep.missed.length}  opt-mal ${rep.optionalWrong.length}  ${rep.ms}ms`}`);
  if (verbose || rep.wrong.length || rep.extra.length || rep.optionalWrong.length) {
    for (const w of rep.wrong) console.log(`    MAL   día ${w.day}: esperado ${JSON.stringify(w.expected)} obtenido ${JSON.stringify(w.got)}${w.why ? ' ' + w.why : ''}`);
    for (const w of rep.optionalWrong) console.log(`    OPT   día ${w.day}: esperado ${JSON.stringify(w.expected)} obtenido ${JSON.stringify(w.got)}`);
    for (const w of rep.extra) console.log(`    EXTRA día ${w.day}: ${JSON.stringify(w.got)}`);
    if (verbose) for (const w of rep.missed) console.log(`    FALTA día ${w.day}: ${JSON.stringify(w.expected)}`);
  }
}

await browser.close();
await server.close();

const sum = (f) => reports.reduce((a, r) => a + f(r), 0);
const required = photos.reduce((a, p) => a + Object.keys(p.days).length, 0);
const summary = {
  impl, photos: photos.length, required,
  correct: sum((r) => r.correct.length), wrong: sum((r) => r.wrong.length), extra: sum((r) => r.extra.length),
  missed: sum((r) => r.missed.length), optionalWrong: sum((r) => r.optionalWrong.length),
  monthOk: reports.filter((r) => r.monthOk).length, layoutOk: reports.filter((r) => r.layoutOk).length,
  errors: reports.filter((r) => r.error).length, avgMs: Math.round(sum((r) => r.ms || 0) / Math.max(1, photos.length)),
};
const byLayout = {};
for (const p of photos) {
  const r = reports.find((x) => x.file === p.file); const L = (byLayout[p.layout] ||= { required: 0, correct: 0, wrong: 0, extra: 0 });
  L.required += Object.keys(p.days).length; L.correct += r.correct.length; L.wrong += r.wrong.length + r.optionalWrong.length; L.extra += r.extra.length;
}
summary.byLayout = byLayout;
summary.accuracy = +(summary.correct / Math.max(1, required)).toFixed(3);
summary.score = summary.correct - 2 * (summary.wrong + summary.extra + summary.optionalWrong);
console.log('\nRESUMEN', JSON.stringify(summary));
if (jsonOut) fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify({ summary, reports }, null, 2));
