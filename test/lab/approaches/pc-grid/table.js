// Localiza la tabla (rejilla) en la foto y calcula la homografía de rectificación.
import { at, toNormal } from './lines.js';
import { intersect, homography, apply, inv } from './geom.js';

// Corte de una recta casi vertical con una casi horizontal (en coordenadas de imagen)
function cross(hl, vl) { return intersect(toNormal(hl), toNormal(vl)); }

// Busca el par de líneas horizontales (borde superior / inferior) atravesado por más verticales.
export function findTable(hs, vs, w, h) {
  const long = Math.max(w, h);
  const H = hs.filter((l) => l.len >= long * 0.12).sort((a, b) => b.len - a.len).slice(0, 40);
  let best = null;
  for (let i = 0; i < H.length; i++) {
    for (let j = 0; j < H.length; j++) {
      if (i === j) continue;
      const T = H[i]; const B = H[j];
      if (Math.abs(Math.atan(T.t) - Math.atan(B.t)) > 0.08) continue;
      // solapamiento horizontal
      const x0 = Math.max(T.a0, B.a0); const x1 = Math.min(T.a1, B.a1);
      if (x1 - x0 < 0.6 * Math.min(T.len, B.len)) continue;
      const xm = (x0 + x1) / 2;
      const yT = at(T, xm)[1]; const yB = at(B, xm)[1];
      const bh = yB - yT; if (bh < long * 0.02) continue;
      const tolX = Math.max(4, long * 0.006); const tolY = Math.max(3, bh * 0.12);
      const span = [];
      for (const V of vs) {
        if (Math.abs(V.t) > 0.6) continue;
        const pT = cross(T, V); const pB = cross(B, V); if (!pT || !pB) continue;
        if (pT[0] < x0 - tolX || pT[0] > x1 + tolX || pB[0] < x0 - tolX || pB[0] > x1 + tolX) continue;
        if (V.a0 > pT[1] + tolY || V.a1 < pB[1] - tolY) continue;
        span.push({ V, pT, pB });
      }
      if (span.length < 8) continue;
      // puntuación: número de verticales; desempate por altura de banda
      const score = span.length + bh / long;
      if (!best || span.length > best.n * 1.05 || (span.length >= best.n * 0.95 && bh > best.bh)) best = { T, B, span, n: span.length, bh, score };
    }
  }
  return best;
}

// Homografía canónica (u,v) → imagen a partir de las verticales de la tabla.
// u: posición horizontal (px rectificados), v: 0 = borde superior, Hr = borde inferior.
export function tableHomography(tb, scale) {
  const sp = tb.span.slice().sort((a, b) => a.pT[0] - b.pT[0]);
  const L = sp[0]; const R = sp[sp.length - 1];
  const topLen = Math.hypot(R.pT[0] - L.pT[0], R.pT[1] - L.pT[1]); const botLen = Math.hypot(R.pB[0] - L.pB[0], R.pB[1] - L.pB[1]);
  const lH = Math.hypot(L.pB[0] - L.pT[0], L.pB[1] - L.pT[1]); const rH = Math.hypot(R.pB[0] - R.pT[0], R.pB[1] - R.pT[1]);
  const Wr = ((topLen + botLen) / 2) * scale; const Hr = ((lH + rH) / 2) * scale;
  // cuadrilátero inicial con las verticales extremas
  let Hm = homography([[0, 0], [Wr, 0], [Wr, Hr], [0, Hr]], [L.pT, R.pT, R.pB, L.pB]);
  // refinado: todas las verticales con su u medido
  for (let it = 0; it < 2 && Hm; it++) {
    const Hi = inv(Hm); const src = []; const dst = [];
    for (const s of sp) {
      const u = (apply(Hi, ...s.pT)[0] + apply(Hi, ...s.pB)[0]) / 2;
      src.push([u, 0], [u, Hr]); dst.push(s.pT, s.pB);
    }
    const H2 = homography(src, dst); if (H2) Hm = H2;
  }
  return { H: Hm, Wr, Hr, left: L, right: R };
}
