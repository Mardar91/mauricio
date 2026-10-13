// Calendario: meses/días en alemán, lectura de la cabecera y asignación de días a filas.

export const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
export const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']; // índice = getUTCDay()

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

export function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Texto de la cabecera → candidatos de mes [{month, score}] y año (o null).
export function parseHeader(text) {
  const norm = String(text || '').toLowerCase().replace(/ae/g, 'ä').replace(/[^a-zäöü0-9 ]/g, ' ');
  const words = norm.split(/\s+/).filter(Boolean);
  const months = [];
  for (let m = 0; m < 12; m++) {
    let best = 0;
    for (const w of words) {
      if (w.length < 3 || /\d/.test(w)) continue;
      const name = MONTHS[m];
      const d = lev(w, name); const s = 1 - d / Math.max(name.length, w.length);
      // prefijo exacto largo (p. ej. palabra cortada)
      const pre = w.length >= 4 && name.startsWith(w) ? 0.85 : 0;
      best = Math.max(best, s, pre);
    }
    months.push({ month: m + 1, score: best });
  }
  months.sort((a, b) => b.score - a.score);
  let year = null; let yearConf = 0;
  const digits = norm.replace(/[^0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 4);
  for (const t of digits) {
    for (let i = 0; i + 4 <= t.length; i++) {
      const y = +t.slice(i, i + 4);
      if (y >= 2020 && y <= 2045) { year = y; yearConf = t.length === 4 ? 1 : 0.6; break; }
    }
    if (year) break;
  }
  return { months, year, yearConf };
}

// Ajusta un texto a un día de la semana: {wd: 0..6, dist}
export function snapWeekday(t) {
  const s = String(t || '').replace(/[^A-Za-z]/g, '');
  if (!s) return null;
  let best = null;
  for (let i = 0; i < 7; i++) {
    const d = lev(s.toLowerCase(), WD[i].toLowerCase());
    if (!best || d < best.dist) best = { wd: i, dist: d, n: 1 };
    else if (d === best.dist) best.n++;
  }
  return best;
}

// Puntuación de un desplazamiento d0 (día = d0 + k) para (año, mes).
// obs: [{k, num: {text, conf}, wd: {text, conf}, weekend: -1..1}]
export function scoreOffset(obs, y, m, d0) {
  const dim = daysInMonth(y, m); let score = 0; let digitHits = 0, wdHits = 0, conflicts = 0;
  for (const o of obs) {
    const d = d0 + o.k;
    if (d < 1 || d > dim) { score -= 3; conflicts++; continue; }
    const want = String(d).padStart(2, '0');
    const t = (o.num?.text || '').replace(/\D/g, '');
    if (t.length) {
      const c = Math.min(1, Math.max(0.3, (o.num.conf || 0) / 90));
      // la app siempre muestra 2 dígitos: una lectura de 1 dígito es parcial y no cuenta
      if (t.length === 2) {
        if (t === want) { score += 3 * c; digitHits++; }
        else if (t[0] === want[0] || t[1] === want[1]) score += 0.6 * c;
        else { score -= 1.2 * c; conflicts++; }
      }
    }
    if (o.wd?.snap) {
      const ok = o.wd.snap.wd === weekday(y, m, d);
      const c = o.wd.snap.dist === 0 && o.wd.snap.n === 1 ? 1 : 0.5;
      if (ok) { score += 1.5 * c; wdHits++; } else score -= 1 * c;
    }
    if (o.weekend) {
      const we = [0, 6].includes(weekday(y, m, d));
      score += (we ? 1 : -1) * o.weekend * 0.8;
    }
  }
  return { score, digitHits, wdHits, conflicts };
}

// Mejor d0 para (año, mes); devuelve {d0, score, margin, ...}
export function bestOffset(obs, y, m) {
  if (!obs.length) return null;
  const dim = daysInMonth(y, m); const ks = obs.map((o) => o.k);
  const kMin = Math.min(...ks), kMax = Math.max(...ks);
  const res = [];
  for (let d0 = 1 - kMax; d0 + kMin <= dim; d0++) res.push({ d0, ...scoreOffset(obs, y, m, d0) });
  if (!res.length) return null;
  res.sort((a, b) => b.score - a.score);
  return { ...res[0], margin: res[0].score - (res[1] ? res[1].score : -10), second: res[1] || null };
}
