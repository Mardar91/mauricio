// Comparación de escaneos con el plan guardado y unión de varias fotos del mismo mes.
import { cleanCode, normalizeDayCodes } from './codes.js';
import { daysInMonth, formatMonth, isKey, makeKey } from './dates.js';

function cleanList(codes) {
  const out = [];
  for (const c of codes || []) {
    const v = cleanCode(c);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

const conf = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : 1);

// Resultado de recognize() → [{key, codes, confidence}] ordenado y sin repetidos.
// Acepta también días que ya traen key (revisión editada en la UI).
export function scanToDays(scanResult, { year, month } = {}) {
  const y = Number(year ?? scanResult?.year);
  const m = Number(month ?? scanResult?.month);
  const byKey = new Map();
  for (const d of scanResult?.days || []) {
    let key = null;
    if (d && isKey(d.key)) key = d.key;
    else if (d && Number.isInteger(y) && m >= 1 && m <= 12) {
      const day = Number(d.day);
      if (Number.isInteger(day) && day >= 1 && day <= daysInMonth(y, m)) key = makeKey(y, m, day);
    }
    if (!key) continue;
    const item = { key, codes: cleanList(d.codes), confidence: conf(d.confidence) };
    if (d.conflict) item.conflict = true;
    const prev = byKey.get(key);
    if (!prev || item.confidence > prev.confidence) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

// Compara con lo guardado: new (no había plan), changed, same
export function diffScan(state, days) {
  return (days || []).map((d) => {
    const prev = state?.days?.[d.key];
    const before = prev ? [...prev.codes] : null;
    const after = normalizeDayCodes(state, d.codes);
    const type = before === null ? 'new' : sameSet(cleanList(before), after) ? 'same' : 'changed';
    const out = { key: d.key, before, after, type };
    if (d.confidence !== undefined) out.confidence = d.confidence;
    if (d.conflict) out.conflict = true;
    return out;
  });
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

// Une varias fotos del mismo mes. Si discrepan en un día gana la variante con más confianza
// (suma de confianzas) y el día queda marcado con conflict: true y confianza rebajada.
export function mergeScans(results) {
  const list = (results || []).filter(Boolean);
  if (!list.length) return { layout: 'unknown', month: null, year: null, days: [], warnings: [] };
  const known = list.filter((r) => r.month && r.year).map((r) => `${r.year}-${r.month}`);
  const target = mostCommon(known);
  const [ty, tm] = target ? target.split('-').map(Number) : [null, null];
  const warnings = [];
  const excluded = [];
  const used = [];
  list.forEach((r, i) => {
    if (target && r.month && r.year && `${r.year}-${r.month}` !== target) {
      excluded.push(i);
      warnings.push(`La foto ${i + 1} es de ${formatMonth(r.year, r.month)}: escanéala aparte.`);
    } else {
      if (target && !(r.month && r.year) && (r.days || []).length) {
        warnings.push(`En la foto ${i + 1} no se vio el mes; se ha supuesto ${formatMonth(ty, tm)}.`);
      }
      used.push(r);
    }
  });
  for (const r of used) for (const w of r.warnings || []) if (!warnings.includes(w)) warnings.push(w);

  const byDay = new Map();
  for (const r of used) {
    for (const d of r.days || []) {
      const day = Number(d.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ codes: cleanList(d.codes), confidence: conf(d.confidence) });
    }
  }
  const days = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const variants = [];
    for (const obs of byDay.get(day)) {
      const v = variants.find((x) => sameSet(x.codes, obs.codes));
      if (v) { v.sum += obs.confidence; v.max = Math.max(v.max, obs.confidence); }
      else variants.push({ codes: obs.codes, sum: obs.confidence, max: obs.confidence });
    }
    variants.sort((a, b) => b.sum - a.sum || b.max - a.max);
    const win = variants[0];
    if (variants.length === 1) {
      days.push({ day, codes: win.codes, confidence: win.max });
    } else {
      const total = variants.reduce((s, v) => s + v.sum, 0);
      days.push({
        day, codes: win.codes,
        confidence: Math.round(Math.min(win.max, total ? win.sum / total : 0) * 100) / 100,
        conflict: true,
        alternatives: variants.slice(1).map((v) => v.codes),
      });
    }
  }
  const layout = mostCommon(used.map((r) => r.layout).filter((l) => l && l !== 'unknown')) ?? 'unknown';
  const out = { layout, month: tm, year: ty, days, warnings };
  if (excluded.length) out.excluded = excluded;
  return out;
}
