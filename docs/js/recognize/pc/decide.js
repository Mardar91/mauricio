// Decisión del código de cada insignia combinando lecturas OCR, plantillas y consenso entre insignias parecidas
// de la misma foto (los turnos se repiten varios días seguidos). Lógica pura: se puede ajustar en Node.
import { similarity, exactNewCode } from './codes.js';

export const DEFAULTS = {
  confFloor: 0.15, // peso mínimo de una lectura OCR aunque Tesseract dé confianza 0
  simMin: 0.4, // similitud mínima lectura↔código para votar
  tmWeight: 0.5, // peso de las plantillas
  tmSupport: 0.1, // voto OCR mínimo de un candidato para que las plantillas lo refuercen
  pinkPrior: 0.25, // W- en la línea de ausencias, Z en la de turnos
  nccMin: 0.82, // parecido mínimo para compartir votos entre insignias
  poolWeight: 0.6, // peso de los votos de las vecinas
  accept: 0.5, // voto mínimo del ganador
  margin: 0.35, // ventaja mínima sobre el segundo
  newMin: 1.8, // suma de confianza (3 lecturas iguales) para aceptar un código nuevo
  ownSupport: 0.1, // apoyo OCR propio mínimo para aceptar el consenso
  poorTm: 0.15, // si ninguna plantilla supera esto, la imagen es pobre
  veryPoorTm: -0.1, // por debajo, la insignia es ilegible
  poorSupport: 0.5, // apoyo OCR exigido entonces
  singleSupport: 0.05, // apoyo OCR mínimo para un color de un solo código conocido (S1, S31)
  partialConf: 0.6, // sin lecturas exactas: confianza mínima de una lectura parcial no repetida
  tmVeto1: 0.05, // desacuerdo con plantillas que anula una decisión apoyada por una sola lectura
  tmVeto: 0.05, // ídem con varias lecturas
  tmVeto1One: 0.2, // códigos con "1" y una sola lectura: desacuerdo grande
  tmVeto1Top: 0.25, // una plantilla con "1" mucho mejor que la del código elegido
  singleReadConf: 0.4, // confianza mínima si solo una lectura apoya al ganador
};

// Votos OCR por candidato de una insignia
export function ocrVotes(b, o) {
  const v = new Map(b.cands.map((c) => [c, 0])); const fresh = new Map();
  for (const r of b.reads) {
    const w = o.confFloor + (1 - o.confFloor) * r.c;
    for (const c of b.cands) { const s = similarity(r.t.toUpperCase(), c); if (s > o.simMin) v.set(c, v.get(c) + (w * (s - o.simMin)) / (1 - o.simMin)); }
    const nw = exactNewCode(r.t, b.cls, b.known); if (nw && r.c >= 0.4) fresh.set(nw, (fresh.get(nw) || 0) + r.c);
  }
  const ocr = new Map(v); // solo OCR (sin previos ni plantillas)
  const freshN = new Map(); // nº de lecturas exactas de cada código nuevo (cualquier confianza)
  for (const r of b.reads) { const nw = exactNewCode(r.t, b.cls, b.known); if (nw) freshN.set(nw, (freshN.get(nw) || 0) + 1); }
  // plantillas: solo refuerzan candidatos que el OCR ya considera posibles (nunca deciden solas)
  if (o.tmWeight && b.tm && b.cands.length > 1) {
    const best = Math.max(...b.cands.map((c) => b.tm[c] ?? -1));
    for (const c of b.cands) if (ocr.get(c) >= o.tmSupport) v.set(c, v.get(c) + (o.tmWeight * Math.max(0, 0.15 - (best - (b.tm[c] ?? -1)))) / 0.15);
  }
  if (b.cls === 'pink') for (const c of b.cands) v.set(c, v.get(c) + ((c === 'W-') === (b.sub === 0) ? o.pinkPrior : 0));
  return { v, fresh, ocr, freshN };
}

export function ncc(a, b) {
  const n = Math.min(a.length, b.length); let ma = 0; let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma; const y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

// Lecturas que apoyan claramente a un código (similitud ≥ 0.85)
function support(b, code) { return b.reads.filter((r) => similarity(r.t.toUpperCase(), code) >= 0.85).length; }

// Desacuerdo con las plantillas: si la mejor plantilla es otra y claramente mejor, no se decide.
// Con una sola lectura basta un desacuerdo pequeño; con varias, uno grande. El "1" (trazo fino, muy
// distinto según la letra y el desenfoque) no se compara con plantillas.
function tmConflict(b, code, o) {
  if (!b.tm || b.cands.length < 2) return false;
  // códigos con "1": solo un desacuerdo muy grande y con una sola lectura a favor
  if (/1/.test(code)) {
    const top = Math.max(...b.cands.map((c) => b.tm[c] ?? -9));
    return support(b, code) <= 1 && top - (b.tm[code] ?? 0) > o.tmVeto1One;
  }
  const pool = b.cands.filter((c) => !/1/.test(c));
  if (pool.length < 2) return false;
  // una plantilla con "1" claramente mejor que la del código elegido también cuenta
  const top1 = b.cands.filter((c) => /1/.test(c)).reduce((a, c) => Math.max(a, b.tm[c] ?? -9), -9);
  if (top1 - (b.tm[code] ?? 0) > o.tmVeto1Top) return true;
  const best = pool.reduce((a, c) => ((b.tm[c] ?? -9) > (b.tm[a] ?? -9) ? c : a), pool[0]);
  if (best === code) return false;
  const d = (b.tm[best] ?? 0) - (b.tm[code] ?? 0);
  return support(b, code) <= 1 ? d > o.tmVeto1 : d > o.tmVeto;
}

// Un código nuevo debe parecerse a su plantilla más que a las de los códigos conocidos
function newFitsTemplate(b, code) {
  if (!b.tm || b.tm[code] == null) return true;
  const known = Math.max(...b.cands.map((c) => b.tm[c] ?? -9));
  return b.tm[code] > known + 0.03;
}

// ¿Alguna lectura de 3+ caracteres empieza por la letra del código (o una confusión típica de ella)?
const LETTER_GROUP = { F: 'FEPf', S: 'S$s', N: 'NMHn', Z: 'Z2z' };
function letterRead(b, code) {
  const g = LETTER_GROUP[code[0]] || code[0];
  return b.reads.some((r) => r.t.length >= 3 && g.includes(r.t[0]));
}

// ¿Las lecturas apoyan claramente un código conocido que no es de la clase de color detectada?
function crossClass(b) {
  const others = (b.known || []).filter((c) => !b.cands.includes(c) && c.length >= 2);
  let best = 0;
  for (const c of others) {
    let sup = 0; for (const r of b.reads) if (r.c >= 0.2 && similarity(r.t.toUpperCase(), c) >= 0.85) sup++;
    best = Math.max(best, sup);
  }
  const mine = Math.max(0, ...b.cands.map((c) => support(b, c)));
  return best >= 2 && mine === 0;
}

// Decide todas las insignias de una foto. Devuelve [{code, conf, isNew}] en el mismo orden.
export function decideAll(badges, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const own = badges.map((b) => ocrVotes(b, o));
  const pick = (b, v, fresh, ocr, freshN) => {
    const list = [...v].sort((a, c) => c[1] - a[1]);
    const [bestCode, bestV] = list[0]; const second = list[1] ? list[1][1] : 0;
    // códigos nuevos leídos que además encajan con su plantilla mejor que los conocidos
    const nb = [...fresh].filter(([c]) => newFitsTemplate(b, c)).sort((a, c) => c[1] - a[1])[0];
    const unanimous = nb && b.reads.length >= 3 && b.reads.every((r) => r.t.toUpperCase() === nb[0]);
    if (nb && nb[1] >= o.newMin && unanimous && (ocr.get(bestCode) || 0) < 0.5) return { code: nb[0], conf: 0.55, isNew: true };
    // otra lectura válida repetida distinta de los conocidos (y plausible según la plantilla): no decidir
    const conflict = (c, x) => (x >= 1.0 || (freshN.get(c) || 0) >= 2) && (newFitsTemplate(b, c) || /1/.test(bestCode));
    if ([...fresh].some(([c, x]) => conflict(c, x)) || [...freshN.keys()].some((c) => conflict(c, 0))) return null;
    // lugares (magenta): si el OCR no distingue la letra (F/S/N), la plantilla sola no basta
    if (b.cls === 'magenta') {
      const ow = ocr.get(bestCode) || 0;
      const tie = b.cands.some((c) => c !== bestCode && c[0] !== bestCode[0] && (ocr.get(c) || 0) >= 0.9 * ow);
      if (tie && !letterRead(b, bestCode)) return null;
    }
    if (b.cands.length === 1) {
      // sin ninguna lectura parecida al código (p. ej. una mancha roja por moiré tomada por S31): no decidir
      if ((ocr.get(bestCode) || 0) < o.singleSupport) return null;
      // lectura exacta de otro código válido y ninguna a favor del conocido: no decidir
      if (b.reads.some((r) => r.c >= 0.3 && exactNewCode(r.t, b.cls, b.known)) && support(b, bestCode) === 0) return null;
      // las lecturas coinciden en otro dígito final (p. ej. "S2", "32", "a2" frente a S1): no decidir
      const dg = new Map(); for (const r of b.reads) { const m = r.t.match(/(\d)$/); if (m) dg.set(m[1], (dg.get(m[1]) || 0) + 1); }
      const mine = (bestCode.match(/(\d)$/) || [])[1];
      if ([...dg].some(([d, n]) => d !== mine && n >= 2) && !dg.get(mine)) return null;
      return { code: bestCode, conf: Math.min(0.95, 0.55 + 0.4 * bestV) };
    }
    // imagen pobre (ninguna plantilla encaja): se exige más apoyo del OCR; muy pobre: no se decide
    const tmMax = b.tm ? Math.max(...b.cands.map((c) => b.tm[c] ?? -9)) : 1;
    if (tmMax < o.veryPoorTm) return null;
    const poor = tmMax < o.poorTm;
    // tres lecturas idénticas que no son el ganador ni una confusión simple de él: el OCR ve otra cosa
    const cnt = new Map(); for (const r of b.reads) if (r.t) cnt.set(r.t, (cnt.get(r.t) || 0) + 1);
    const [maj, majN] = [...cnt].sort((a, c) => c[1] - a[1])[0] || ['', 0];
    if (majN >= 3 && similarity(maj.toUpperCase(), bestCode) < 0.85) return null;
    if (bestV >= o.accept && bestV - second >= o.margin && (ocr.get(bestCode) || 0) >= (poor ? o.poorSupport : o.ownSupport)) {
      if (tmConflict(b, bestCode, o)) return null;
      // una sola lectura a favor, y floja: no basta
      const sup = b.reads.filter((r) => similarity(r.t.toUpperCase(), bestCode) >= 0.85);
      // sin ninguna lectura (casi) exacta, solo con lecturas parciales muy flojas: no basta
      if (!sup.length) {
        // la mejor lectura parcial a favor del ganador debe repetirse o ser bastante segura
        const part = b.reads.filter((r) => r.t && similarity(r.t.toUpperCase(), bestCode) > o.simMin);
        const rep = part.some((r) => part.filter((x) => x.t === r.t).length >= 2);
        if (!rep && Math.max(0, ...part.map((r) => r.c)) < o.partialConf) return null;
      }
      if (sup.length === 1 && (sup[0].c < o.singleReadConf || poor)) return null;
      // si el OCR no distingue al ganador de otro candidato, decide la plantilla: solo con margen y sin "1"
      const ow = ocr.get(bestCode) || 0;
      for (const c of b.cands) {
        if (c === bestCode || (ocr.get(c) || 0) < 0.9 * ow) continue;
        const m = b.tm ? (b.tm[bestCode] ?? 0) - (b.tm[c] ?? 0) : 0;
        if (m < 0.05 || /1/.test(c) || /1/.test(bestCode)) return null;
      }
      return { code: bestCode, conf: Math.min(1, 0.4 + 0.5 * (bestV - second)) };
    }
    return null;
  };
  return badges.map((b, i) => {
    if (!b.cands.length) return { code: null, conf: 0 };
    // rosa: la sub-línea decide entre W- (ausencias, arriba) y Z (turno); el OCR solo puede vetar
    // el OCR lee con claridad un código conocido de otro color (colores lavados): no decidir
    if (crossClass(b)) return { code: null, conf: 0 };
    if (b.cls === 'pink' && (b.sub === 0 || b.sub === 1)) {
      const want = b.cands.filter((c) => (b.sub === 0 ? /^W/.test(c) : /^Z/.test(c)));
      const other = b.cands.filter((c) => !want.includes(c));
      const ov = Math.max(0, ...other.map((c) => own[i].ocr.get(c) || 0));
      const fN = own[i].freshN;
      if (want.length === 1 && ov < 0.6 && ![...own[i].fresh].some(([c, x]) => (x >= 1.0 || (fN.get(c) || 0) >= 2) && (newFitsTemplate(b, c) || /1/.test(want[0])))) {
        return { code: want[0], conf: Math.min(0.9, 0.6 + 0.3 * (own[i].ocr.get(want[0]) || 0)) };
      }
    }
    // una "insignia" que el OCR lee como U es la U roja de vacaciones (halo rosado)
    if ((b.cls === 'pink' || b.cls === 'red') && b.sub === 0 && b.reads.filter((r) => /^u$/i.test(r.t)).length >= 2) return { code: 'U', conf: 0.6 };
    // primero la evidencia propia; si no basta, consenso con insignias de aspecto casi idéntico
    const mine = pick(b, own[i].v, own[i].fresh, own[i].ocr, own[i].freshN);
    if (mine) return mine;
    if (!(o.poolWeight > 0 && b.sig)) return { code: null, conf: 0 };
    const v = new Map(own[i].v);
    badges.forEach((x, j) => {
      if (j === i || x.cls !== b.cls || !x.sig) return;
      if (Math.abs(Math.log(x.asp / b.asp)) > 0.15) return;
      const s = ncc(b.sig, x.sig); if (s < o.nccMin) return;
      const w = (o.poolWeight * (s - o.nccMin)) / (1 - o.nccMin);
      for (const [c, val] of own[j].v) v.set(c, v.get(c) + w * val);
    });
    const pooled = pick(b, v, own[i].fresh, own[i].ocr, own[i].freshN);
    // el consenso solo completa: la propia insignia debe apoyar algo al ganador
    if (!pooled || (own[i].ocr.get(pooled.code) || 0) < o.ownSupport) return { code: null, conf: 0 };
    return { ...pooled, conf: Math.min(pooled.conf, 0.7), pooled: true };
  });
}
