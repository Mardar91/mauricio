// Calendario: meses y días de la semana en alemán, coincidencia aproximada de textos OCR.

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
