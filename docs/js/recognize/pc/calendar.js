// Calendario: meses y días de la semana en alemán, coincidencia aproximada de textos OCR y nombre del empleado.

export const MONTHS_DE = ['januar', 'februar', 'marz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
export const WEEKDAYS_DE = ['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so']; // lunes primero

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// 0 = lunes … 6 = domingo
export const weekdayIdx = (y, m, d) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;

export function norm(s) {
  return String(s || '').toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');
}

export function lev(a, b) {
  const m = a.length; const n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Candidatos de mes a partir de una palabra OCR: [{month, score}] (score 0..1)
export function monthCandidates(word) {
  const w = norm(word).replace(/\d+/g, '');
  if (w.length < 3) return [];
  const out = [];
  MONTHS_DE.forEach((m, i) => {
    const d = lev(w, m);
    const tol = m.length <= 4 ? 1 : 2;
    if (d <= tol) out.push({ month: i + 1, score: 1 - d / (m.length + 1) });
    else if (w.length >= 5 && m.startsWith(w.slice(0, 4)) && d <= 3) out.push({ month: i + 1, score: 0.5 });
  });
  return out;
}

// Años plausibles (20xx) en un texto
export function yearCandidates(word) {
  const out = []; const s = String(word).replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  for (const m of s.matchAll(/(?:^|\D)(20[2-4]\d)(?!\d)/g)) out.push(Number(m[1]));
  return out;
}

// Fechas dd.mm.yyyy en un texto
export function dateCandidates(text) {
  const out = []; const s = String(text).replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  for (const m of s.matchAll(/(\d{1,2})\s?[.,\-]\s?(\d{1,2})\s?[.,\-\s]\s?(20[2-4]\d)/g)) {
    const d = +m[1]; const mo = +m[2]; const y = +m[3];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) out.push({ day: d, month: mo, year: y });
  }
  return out;
}

// Día de la semana (0..6) a partir de una abreviatura OCR, o -1
export function weekdayFromText(t) {
  const w = norm(t).replace(/[0-9]/g, '');
  if (!w) return -1;
  const fix = { m0: 'mo', mn: 'mo', d1: 'di', dl: 'di', m1: 'mi', ml: 'mi', fe: 'fr', f: 'fr', s0: 'so', d0: 'do' };
  const x = fix[w] || w;
  const i = WEEKDAYS_DE.indexOf(x.slice(0, 2));
  return x.length <= 3 ? i : -1;
}

// Nombre del empleado en la tabla (SPEC §11). El nombre del plan («Ducuara Ana») se parte en palabras de
// ≥ 3 letras; una fila es la buscada si su nombre leído (OCR) contiene TODAS, sin acentos y con la
// tolerancia de Levenshtein de siempre: max(1, ⌊largo/4⌋).

// Sin nombre: el apellido de siempre (compatibilidad)
export const DEFAULT_EMPLOYEE = 'Ducuara';

const SPECIAL = { ß: 'ss', ł: 'l', ø: 'o', đ: 'd', æ: 'ae', œ: 'oe', ı: 'i' };

// Minúsculas sin acentos ni signos («Pérez-Müller» → «perezmuller»)
export function normName(s) {
  return String(s || '').toLowerCase().replace(/[ßłøđæœı]/g, (c) => SPECIAL[c])
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

// Nombre para los avisos: espacios simples y largo limitado
export function nameLabel(name) {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

// Palabras del nombre que hay que encontrar (≥ 3 letras; «de», «la»… no cuentan)
export function nameTokens(name) {
  return String(name || '').split(/[\s,;/]+/).map(normName).filter((t) => t.length >= 3);
}

const tol = (t) => Math.max(1, Math.floor(t.length / 4));
// Nombres cortos («Ana», «Eva», «Juan»): sin tolerancia, si no «Juana» o «Diana» valdrían por «Ana»
const SHORT_NAME = 4;
const isShort = (t) => t.length <= SHORT_NAME;

// ¿Las palabras leídas (OCR) contienen todas las del nombre? → { ok, missing }
// Además de cada palabra, se prueba cada pareja de palabras seguidas (OCR que parte «Mauri cio») y,
// para dos palabras del nombre seguidas, una lectura que las pega («DucuaraMauricio»): cada parte con su
// tolerancia y la segunda con su largo exacto. Un nombre de ≤ 4 letras tiene que salir tal cual y en
// una sola palabra (o pegado): «A» + «na» (restos de OCR) no es «Ana».
export function matchName(words, tokens) {
  const ws = (words || []).map((w) => normName(typeof w === 'string' ? w : w && w.text)).filter(Boolean);
  const cands = [];
  ws.forEach((w, i) => { cands.push(w); if (i + 1 < ws.length) cands.push(w + ws[i + 1]); });
  const close = (c, t) => (isShort(t) ? c === t : c.length >= 3 && Math.abs(c.length - t.length) <= tol(t) && lev(c, t) <= tol(t));
  const hit = tokens.map((t) => (isShort(t) ? ws : cands).some((c) => close(c, t)));
  const glued = (a, b) => cands.some((c) => {
    const k = c.length - b.length;
    return k >= 3 && close(c.slice(0, k), a) && close(c.slice(k), b);
  });
  for (let i = 0; i + 1 < tokens.length; i++) if (!(hit[i] && hit[i + 1]) && glued(tokens[i], tokens[i + 1])) hit[i] = hit[i + 1] = true;
  return { ok: tokens.length > 0 && hit.every(Boolean), missing: tokens.filter((_, i) => !hit[i]) };
}

// Tabla de una sola fila (impresión filtrada): lecturas del nombre ([{ ok, missing, legible }], la 2.ª
// con contraste normalizado) → { ok, otherName (se lee texto, pero no el nombre), nameMismatch (palabras
// que faltan si se lee PARTE del nombre: casi seguro la hoja de otra persona, p. ej. la del hermano) }
export function checkSingleRow(reads, tokens) {
  const ok = reads.some((m) => m.ok);
  const partial = ok ? [] : reads.filter((m) => m.missing.length < tokens.length).sort((a, c) => a.missing.length - c.missing.length);
  return { ok, otherName: !ok && reads.some((m) => m.legible), nameMismatch: partial.length ? partial[0].missing : null };
}

// Varias filas (SPEC §11): vale la única cuyo nombre contiene TODAS las palabras del nombre del plan.
// Con solo una palabra (el apellido) no se distingue a dos «Ducuara»: ninguna fila (needFullName).
// readName(i, flat) → { ok, missing }: 2.ª lectura (flat) si ninguna encaja, o de las que encajan a medias
// si encaja una (¿otra con el mismo nombre?). → { index (-1: ninguna), hits, needFullName? }
export async function chooseRow(count, tokens, readName) {
  if (!tokens.length) return { index: -1, hits: 0 };
  if (tokens.length < 2) return { index: -1, hits: 0, needFullName: true };
  const ms = [];
  for (let i = 0; i < count; i++) ms.push({ ...(await readName(i, false)) });
  const n1 = ms.filter((m) => m.ok).length;
  if (n1 <= 1) {
    for (let i = 0; i < count; i++) {
      if (ms[i].ok || (n1 === 1 && ms[i].missing.length === tokens.length)) continue;
      if ((await readName(i, true)).ok) ms[i].ok = true;
    }
  }
  const hits = ms.map((m, i) => (m.ok ? i : -1)).filter((i) => i >= 0);
  return { index: hits.length === 1 ? hits[0] : -1, hits: hits.length };
}

// Aviso cuando la hoja (una sola fila) es de otra persona: se lee parte del nombre del plan (el
// apellido) pero falta otra parte. La revisión no marca esos días (confianza baja).
export const OTHER_SHEET_WARNING = 'Esta hoja parece de otra persona';
// label: nombre del plan («Ducuara Ana»); missing: palabras que faltan (de nameTokens)
export function otherSheetWarning(label, missing) {
  const words = String(label || '').split(/[\s,;/]+/).filter((w) => missing.includes(normName(w)));
  const list = words.length ? words : missing;
  const shown = list.map((w) => `«${w}»`).join(' ni ');
  return `${OTHER_SHEET_WARNING}: no veo ${shown} en el nombre. Revisa antes de guardar.`;
}
