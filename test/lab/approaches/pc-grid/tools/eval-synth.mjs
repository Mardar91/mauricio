// Evalúa el reconocedor sobre un conjunto sintético (gt.json + jpg en un directorio fuera del servidor).
// Uso: node test/lab/approaches/pc-grid/tools/eval-synth.mjs --dir <dir> [--impl ruta] [--only a,b] [--debug outdir] [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const impl = opt('impl', 'test/lab/approaches/pc-grid/recognize.js');
const dir = path.resolve(opt('dir', '.'));
const only = opt('only', '');
const dbgOut = opt('debug', '');
const verbose = !!opt('verbose', false);
const extraOpts = JSON.parse(opt('opts', '{}'));
const KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];
const GT = JSON.parse(fs.readFileSync(path.join(dir, 'gt.json'), 'utf8'));
const photos = GT.photos.filter((p) => !only || String(only).split(',').some((s) => p.file.includes(s)));
const sameSet = (a, b) => [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');

function score(gt, result) {
  const rep = { file: gt.file, layoutOk: result.layout === gt.layout, monthOk: result.month === gt.month && result.year === gt.year, correct: [], wrong: [], missed: [], extra: [], optionalWrong: [] };
  const byDay = new Map(); for (const d of result.days || []) { if (byDay.has(d.day)) rep.wrong.push({ day: d.day, why: 'dup' }); byDay.set(d.day, d); }
  for (const [k, exp] of Object.entries(gt.days)) {
    const r = byDay.get(Number(k));
    if (!r) rep.missed.push({ day: +k, expected: exp }); else if (sameSet(r.codes, exp)) rep.correct.push(+k); else rep.wrong.push({ day: +k, expected: exp, got: r.codes, conf: r.confidence });
  }
  for (const [day, r] of byDay) {
    if (gt.days[String(day)]) continue;
    if (String(day) in (gt.optional || {})) { const exp = gt.optional[String(day)]; if (exp && !sameSet(r.codes, exp)) rep.optionalWrong.push({ day, expected: exp, got: r.codes }); } else rep.extra.push({ day, got: r.codes });
  }
  return rep;
}

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('console', (m) => { if ((verbose || m.type() === 'error') && !/Estimating resolution|diacritics/.test(m.text())) console.log('  [browser]', m.text().slice(0, 600)); });
await page.goto(server.url + '/test/lab/harness.html');
if (dbgOut) fs.mkdirSync(dbgOut, { recursive: true });
const reps = [];
for (const p of photos) {
  const b64 = fs.readFileSync(path.join(dir, p.file)).toString('base64');
  let rep;
  try {
    const { result, ms } = await page.evaluate(async ([i, data, d, k, ex]) => {
      const mod = await import(i);
      const blob = await (await fetch('data:image/jpeg;base64,' + data)).blob();
      const t0 = performance.now();
      const result = await mod.recognize(blob, { tesseract: window.TESS_PATHS, debug: d, knownCodes: k, ...ex });
      return { result, ms: performance.now() - t0 };
    }, [server.url + '/' + impl, b64, !!dbgOut, KNOWN, extraOpts]);
    rep = score(p, result); rep.ms = Math.round(ms); rep.warnings = result.warnings; rep.got = `${result.layout} ${result.month}/${result.year}`;
    if (dbgOut && result.debug && result.debug.overlay) fs.writeFileSync(path.join(dbgOut, p.file.replace(/\.jpg$/, '.png')), Buffer.from(result.debug.overlay.split(',')[1], 'base64'));
    if (dbgOut && result.debug && result.debug.info) fs.writeFileSync(path.join(dbgOut, p.file.replace(/\.jpg$/, '.json')), JSON.stringify(result.debug.info, null, 1));
  } catch (e) { rep = { file: p.file, error: String(e.message || e).slice(0, 300), correct: [], wrong: [], missed: Object.keys(p.days), extra: [], optionalWrong: [] }; }
  reps.push(rep);
  const req = Object.keys(p.days).length;
  const m = p.meta || {};
  console.log(`${p.file.padEnd(20)} ${rep.error ? 'ERROR ' + rep.error : `${rep.layoutOk ? 'ok' : 'LAYOUT(' + rep.got + ')'} ${rep.monthOk ? 'mes-ok' : 'MES(' + rep.got + ' vs ' + p.month + '/' + p.year + ')'} ok ${rep.correct.length}/${req} mal ${rep.wrong.length} extra ${rep.extra.length} opt-mal ${rep.optionalWrong.length} ${rep.ms}ms`} [${m.clean ? 'clean' : `W${m.W} rot${m.rot} blur${m.blur}`}${m.finger ? ' dedo' : ''}${m.nEmp > 1 ? ' emp' + m.nEmp : ''}${m.titleOk === false ? ' sin-titulo' : ''}]`);
  if (verbose || rep.wrong.length || rep.extra.length || rep.optionalWrong.length) {
    for (const w of rep.wrong) console.log(`    MAL  ${w.day}: esperado ${JSON.stringify(w.expected)} obtenido ${JSON.stringify(w.got)} (${w.conf})`);
    for (const w of rep.extra) console.log(`    EXTRA ${w.day}: ${JSON.stringify(w.got)}`);
    for (const w of rep.optionalWrong) console.log(`    OPT  ${w.day}: esperado ${JSON.stringify(w.expected)} obtenido ${JSON.stringify(w.got)}`);
  }
}
await browser.close(); await server.close();
const sum = (f) => reps.reduce((a, r) => a + f(r), 0);
const required = photos.reduce((a, p) => a + Object.keys(p.days).length, 0);
const s = { photos: photos.length, required, correct: sum((r) => r.correct.length), wrong: sum((r) => r.wrong.length), extra: sum((r) => r.extra.length), optionalWrong: sum((r) => r.optionalWrong.length),
  monthOk: reps.filter((r) => r.monthOk).length, layoutOk: reps.filter((r) => r.layoutOk).length, errors: reps.filter((r) => r.error).length, avgMs: Math.round(sum((r) => r.ms || 0) / Math.max(1, photos.length)) };
s.accuracy = +(s.correct / Math.max(1, required)).toFixed(3); s.score = s.correct - 2 * (s.wrong + s.extra + s.optionalWrong);
console.log('\nSINTETICO', JSON.stringify(s));
