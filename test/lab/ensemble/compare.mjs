// Compara informes JSON de test/lab/eval.mjs (--json): días por foto, unión y reglas de disparo.
// Uso: node test/lab/ensemble/compare.mjs A.json B.json            → diferencias por foto
//      node test/lab/ensemble/compare.mjs --union A.json B.json    → unión y reglas "B solo si A incompleto"
import fs from 'node:fs';

const args = process.argv.slice(2);
const union = args.includes('--union');
const [fa, fb] = args.filter((a) => !a.startsWith('--'));
const load = (f) => new Map(JSON.parse(fs.readFileSync(f, 'utf8')).reports.map((r) => [r.file, r]));
const A = load(fa); const B = load(fb);
const daysOf = (r) => new Map([...r.correct, ...r.wrong.map((w) => ({ day: w.day, codes: w.got })), ...r.extra.map((w) => ({ day: w.day, codes: w.got })), ...(r.optionalOk || []), ...(r.optionalWrong || []).map((w) => ({ day: w.day, codes: w.got }))].map((d) => [d.day, [...d.codes].sort().join('|')]));

if (!union) {
  let diff = 0;
  for (const [f, ra] of A) {
    const rb = B.get(f); if (!rb) { console.log('falta en B:', f); continue; }
    const da = daysOf(ra); const db = daysOf(rb);
    const keys = [...new Set([...da.keys(), ...db.keys()])].sort((x, y) => x - y);
    const d = keys.filter((k) => da.get(k) !== db.get(k));
    const g = JSON.stringify(ra.got) !== JSON.stringify(rb.got);
    if (d.length || g) { diff++; console.log(f.split('/').slice(-2).join('/'), g ? `got ${JSON.stringify(ra.got)} vs ${JSON.stringify(rb.got)}` : '', d.map((k) => `${k}: ${da.get(k) ?? '·'} vs ${db.get(k) ?? '·'}`).join('; ')); }
  }
  console.log(`${diff} fotos con diferencias de ${A.size}`);
} else {
  const rows = [];
  for (const [f, ra] of A) {
    const rb = B.get(f); if (!rb) continue;
    const ca = new Set(ra.correct.map((d) => d.day)); const cb = new Set(rb.correct.map((d) => d.day));
    const req = ra.correct.length + ra.missed.length + ra.wrong.length;
    rows.push({ f, req, ca: ca.size, u: new Set([...ca, ...cb]).size, msA: ra.ms, msB: rb.ms, warnA: ra.warnings || [], gotA: ra.got, ndA: daysOf(ra).size, wrongB: rb.wrong.length + rb.extra.length });
  }
  const req = rows.reduce((s, r) => s + r.req, 0);
  const rule = (name, fn) => {
    let c = 0, t = 0, n = 0;
    for (const r of rows) { const run = fn(r); c += run ? r.u : r.ca; t += r.msA + (run ? r.msB : 0); n += run ? 1 : 0; }
    console.log(`${name.padEnd(44)} ${c}/${req} (${(100 * c / req).toFixed(1)} %)  B en ${n}/${rows.length}  ~${Math.round(t / rows.length)} ms`);
  };
  rule('solo A', () => false);
  rule('A + B siempre', () => true);
  const inc = (k) => (r) => r.gotA.layout !== 'phone-list' || r.gotA.month == null || r.gotA.year == null || r.warnA.length > 0 || r.ndA < k;
  for (const k of [6, 8, 9, 10, 11, 12]) rule(`A incompleto (avisos, mes, < ${k} días)`, inc(k));
  rule('A con avisos o sin mes', inc(0));
}
