// Evalúa el reconocedor sobre las imágenes sintéticas/aumentadas (solo desarrollo).
// Uso: node test/lab/approaches/color-first/tools/eval-synth.mjs [--gt synth/aug.json] [--only txt] [--debug] [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../../../tools/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const gtFile = path.resolve(HERE, '..', opt('gt', 'synth/aug.json'));
const impl = opt('impl', 'test/lab/approaches/color-first/recognize.js');
const only = opt('only', ''); const debug = !!opt('debug', false); const verbose = !!opt('verbose', false);
const GT = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
const KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];
const photos = GT.photos.filter((p) => !only || String(only).split(',').some((s) => p.file.includes(s)));
const same = (a, b) => [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');

const server = await startServer(0);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (verbose && m.type() === 'log') console.log('  [b]', m.text().slice(0, 300)); });
await page.goto(server.url + '/test/lab/harness.html');
const outDir = path.join(HERE, '..', 'synth', 'out'); if (debug) fs.mkdirSync(outDir, { recursive: true });
const tot = { req: 0, ok: 0, wrong: 0, extra: 0, optWrong: 0, month: 0, layout: 0, ms: 0, n: 0 };
const byVar = {};
for (const p of photos) {
  let r;
  try {
    r = await page.evaluate(([i, f, d, k]) => window.runRecognizer(i, f, { debug: d, knownCodes: k }), [server.url + '/' + impl, server.url + '/' + p.file, debug, KNOWN]);
  } catch (e) { console.log(p.file, 'ERROR', String(e).slice(0, 200)); continue; }
  const res = r.result; const by = new Map(res.days.map((d) => [d.day, d]));
  let ok = 0, wrong = [], extra = [], optWrong = [];
  for (const [k, exp] of Object.entries(p.days)) { const g = by.get(+k); if (!g) continue; if (same(g.codes, exp)) ok++; else wrong.push(`${k}:${g.codes.join('+')}≠${exp.join('+')}`); }
  for (const [d, g] of by) {
    if (p.days[String(d)]) continue;
    const o = (p.optional || {})[String(d)];
    if (o === null) continue;
    if (o) { if (!same(g.codes, o)) optWrong.push(`${d}:${g.codes.join('+')}≠${o.join('+')}`); }
    else extra.push(`${d}:${g.codes.join('+')}`);
  }
  if (res.days.length !== by.size) wrong.push('duplicados');
  const req = Object.keys(p.days).length;
  const monthOk = res.month === p.month && res.year === p.year;
  tot.req += req; tot.ok += ok; tot.wrong += wrong.length; tot.extra += extra.length; tot.optWrong += optWrong.length; tot.month += monthOk ? 1 : 0; tot.layout += res.layout === p.layout ? 1 : 0; tot.ms += r.ms; tot.n++;
  const v = (byVar[p.variant || '-'] ||= { req: 0, ok: 0, bad: 0, month: 0, n: 0 }); v.req += req; v.ok += ok; v.bad += wrong.length + extra.length + optWrong.length; v.month += monthOk ? 1 : 0; v.n++;
  console.log(`${path.basename(p.file).padEnd(34)} ${res.layout === p.layout ? 'L' : 'l'}${monthOk ? 'M' : 'm(' + res.month + '/' + res.year + ')'} ok ${ok}/${req}${wrong.length ? ' MAL ' + wrong.join(' ') : ''}${extra.length ? ' EXTRA ' + extra.join(' ') : ''}${optWrong.length ? ' OPT ' + optWrong.join(' ') : ''} ${Math.round(r.ms)}ms`);
  if (debug && res.debug && res.debug.overlay) fs.writeFileSync(path.join(outDir, path.basename(p.file).replace(/\.jpg$/, '.png')), Buffer.from(res.debug.overlay.split(',')[1], 'base64'));
}
await browser.close(); await server.close();
console.log('\nPOR VARIANTE'); for (const [k, v] of Object.entries(byVar)) console.log(`  ${k.padEnd(10)} ok ${v.ok}/${v.req} malos ${v.bad} mes ${v.month}/${v.n}`);
console.log(`SINTÉTICO ok ${tot.ok}/${tot.req} (${(tot.ok / Math.max(1, tot.req) * 100).toFixed(1)}%) mal ${tot.wrong} extra ${tot.extra} opt-mal ${tot.optWrong} mes ${tot.month}/${tot.n} layout ${tot.layout}/${tot.n} media ${Math.round(tot.ms / Math.max(1, tot.n))}ms score ${tot.ok - 2 * (tot.wrong + tot.extra + tot.optWrong)}`);
