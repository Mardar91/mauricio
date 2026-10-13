// Reproduce sin OCR la decisión del conjunto (regla de disparo de B + fusión de docs/js/recognize/index.js)
// sobre los resultados en bruto de collect.mjs, y la puntúa contra la verdad de referencia.
// Uso: node test/lab/ensemble/analyze.mjs <col.json> [<col2.json> …] [--list] [--rules '{"soloMinConf":0.6}']
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksIncomplete, mergePhone, sanitize, RULES } from '../../../docs/js/recognize/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const list = args.includes('--list');
const ri = args.indexOf('--rules');
const rules = ri >= 0 ? { ...RULES, ...JSON.parse(args[ri + 1]) } : RULES;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--rules');
const KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];
const sameSet = (x, y) => [...new Set(x)].sort().join('|') === [...new Set(y)].sort().join('|');

function score(gt, res) {
  let ok = 0, bad = 0, extra = 0; const errs = [];
  for (const d of res.days) {
    const req = gt.days[String(d.day)];
    const exp = req || (gt.optional || {})[String(d.day)];
    if (exp === undefined) { extra++; errs.push(`EXTRA ${d.day} ${d.codes}`); } else if (exp === null) continue;
    else if (!sameSet(exp, d.codes)) { bad++; errs.push(`MAL ${d.day} ${d.codes} (esperado ${exp}) conf ${d.confidence}`); } else if (req) ok++;
  }
  return { ok, bad, extra, req: Object.keys(gt.days).length, errs, monthOk: res.month === gt.month && res.year === gt.year };
}

// --why: para los días que solo lee uno de los dos, qué dijo el otro lector de esa fila (bien / mal)
if (args.includes('--why')) {
  const stat = {};
  for (const f of files) {
    const col = JSON.parse(fs.readFileSync(f, 'utf8'));
    const gt = new Map(JSON.parse(fs.readFileSync(path.resolve(ROOT, col.gt), 'utf8')).photos.map((p) => [p.file, p]));
    for (const p of col.photos) {
      const g = gt.get(p.file); if (!g || g.layout !== 'phone-list') continue;
      const a = sanitize(p.a); const b = sanitize(p.b);
      for (const [x, y, nx] of [[a, b, 'A'], [b, a, 'B']]) {
        const other = new Set(y.days.map((d) => d.day));
        for (const d of x.days) {
          if (other.has(d.day)) continue;
          const req = g.days[String(d.day)]; const exp = req || (g.optional || {})[String(d.day)];
          if (exp === null || (exp === undefined && !req)) { if (exp === undefined) { const k = `${nx} solo, otro=${(y.unreadWhy || {})[d.day] || ((y.unread || []).includes(d.day) ? 'no leído' : 'no visto')}`; (stat[k] ||= { bien: 0, mal: 0, confs: [] }).mal++; } continue; }
          const ok = sameSet(exp, d.codes);
          const k = `${nx} solo, otro=${(y.unreadWhy || {})[d.day] || ((y.unread || []).includes(d.day) ? 'no leído' : 'no visto')}`;
          const st = (stat[k] ||= { bien: 0, mal: 0, confs: [] });
          if (ok) st.bien++; else { st.mal++; st.confs.push(d.confidence); }
          (st.c ||= {})[d.confidence] = ((st.c || {})[d.confidence] || 0) + (ok ? 1 : 0);
        }
      }
    }
  }
  for (const [k, v] of Object.entries(stat).sort()) console.log(`${k.padEnd(48)} bien ${String(v.bien).padStart(4)}  mal ${v.mal}${v.confs.length ? ' (conf ' + v.confs.join(',') + ')' : ''}  conf de los bien: ${JSON.stringify(Object.entries(v.c || {}).filter(([, n]) => n).sort((p, q) => p[0] - q[0]).map(([c, n]) => c + ':' + n).join(' '))}`);
  process.exit(0);
}

for (const f of files) {
  const col = JSON.parse(fs.readFileSync(f, 'utf8'));
  const gt = new Map(JSON.parse(fs.readFileSync(path.resolve(ROOT, col.gt), 'utf8')).photos.map((p) => [p.file, p]));
  const modes = { 'solo A': () => false, 'B siempre': () => true, 'B si A incompleto': (a) => looksIncomplete(a, rules) };
  console.log(`\n== ${path.basename(f)} (${col.photos.length} fotos; se omiten las de la tabla del PC)`);
  for (const [name, trig] of Object.entries(modes)) {
    const tot = { ok: 0, bad: 0, extra: 0, req: 0, ms: 0, runs: 0, n: 0, month: 0 }; const errs = [];
    for (const p of col.photos) {
      const g = gt.get(p.file);
      if (!g || g.layout !== 'phone-list') continue;
      const a = sanitize(p.a); const b0 = sanitize(p.b);
      const runB = trig(a);
      const res = mergePhone(a, runB ? b0 : null, KNOWN, rules);
      const s = score(g, res);
      tot.ok += s.ok; tot.bad += s.bad; tot.extra += s.extra; tot.req += s.req; tot.n++; tot.month += s.monthOk ? 1 : 0;
      tot.ms += p.a.ms + (runB ? p.b.ms : 0); tot.runs += runB ? 1 : 0;
      for (const e of s.errs) errs.push(`${p.file.split('/').slice(-2).join('/')}: ${e}`);
    }
    console.log(`${name.padEnd(20)} ${tot.ok}/${tot.req} (${(100 * tot.ok / tot.req).toFixed(1)} %)  mal ${tot.bad}  extra ${tot.extra}  mes ok ${tot.month}/${tot.n}  B en ${tot.runs}/${tot.n}  ~${Math.round(tot.ms / tot.n)} ms/foto`);
    if (list || name !== 'solo A') for (const e of errs) console.log('     ' + e);
  }
}
