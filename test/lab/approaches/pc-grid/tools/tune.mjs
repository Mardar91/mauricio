// Ajuste offline de la decisión de insignias (decide.js) con las evidencias guardadas por eval-synth --debug.
// Uso: node test/lab/approaches/pc-grid/tools/tune.mjs <dirSintético> <dirDebug> ['{"param":valor}'] [--list]
import fs from 'node:fs';
import path from 'node:path';
import { decideAll, DEFAULTS } from '../decide.js';
import { classCandidates } from '../codes.js';

const [dir, dbg, js] = process.argv.slice(2);
const list = process.argv.includes('--list');
const params = js && js.startsWith('{') ? JSON.parse(js) : {};
const gt = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, 'gt.json'), 'utf8')).photos.map((p) => [p.file.replace(/\.jpg$/, ''), p]));
const RE = { yellow: /^F\d$/, green: /^S\d$/, blue: /^(N\d|TS)$/, pink: /^(Z\d|W-)$/, magenta: /^[FSNZ]\d\d$/, red: /^S\d\d$/ };
const st = {}; const bad = [];
for (const f of fs.readdirSync(dbg).filter((x) => x.endsWith('.json'))) {
  const name = f.replace(/\.json$/, ''); const g = gt[name]; if (!g) continue;
  const info = JSON.parse(fs.readFileSync(path.join(dbg, f), 'utf8'));
  if (!info.badges) continue;
  for (const b of info.badges) b.cands = classCandidates(b.cls, b.known); // con las reglas actuales
  const dec = decideAll(info.badges, params);
  info.badges.forEach((b, i) => {
    const exp = (g.days[String(b.day)] || []).filter((c) => RE[b.cls] && RE[b.cls].test(c));
    if (exp.length !== 1) return; // sin etiqueta clara
    const k = b.cls; st[k] ||= { ok: 0, wrong: 0, nul: 0 };
    const d = dec[i];
    if (!d.code) st[k].nul++; else if (d.code === exp[0]) st[k].ok++; else { st[k].wrong++; bad.push(`${name} d${b.day} ${b.cls} esperado ${exp[0]} → ${d.code} reads=${b.reads.map((r) => r.t + ":" + r.c).join(",")} tm=${JSON.stringify(b.tm)}`); }
  });
}
let ok = 0; let wrong = 0; let nul = 0;
for (const [k, v] of Object.entries(st)) { ok += v.ok; wrong += v.wrong; nul += v.nul; console.log(k.padEnd(8), JSON.stringify(v)); }
console.log('TOTAL', { ok, wrong, nul, score: ok - 4 * wrong }, JSON.stringify({ ...DEFAULTS, ...params }));
if (list) bad.forEach((x) => console.log('  ', x));
