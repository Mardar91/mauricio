// Heurística de disposición: la tabla impresa del PC tiene muchas insignias pequeñas (amarillas,
// verdes, magenta) alineadas en una misma fila horizontal; la lista del móvil, como mucho 3 por fila.
import { hsv, components } from './raster.js';
import { median } from './geom.js';

export function looksLikePcGrid(ana) {
  const { w, h, data } = ana; const mask = new Uint8Array(w * h);
  for (let p = 0, q = 0; p < w * h; p++, q += 4) {
    const [hu, s, v] = hsv(data[q], data[q + 1], data[q + 2]);
    if (v < 90) continue;
    if ((hu >= 45 && hu < 75 && s >= 0.45) || (hu >= 80 && hu < 160 && s >= 0.28) || (hu >= 280 && hu < 335 && s >= 0.4)) mask[p] = 1;
  }
  const { comps } = components(mask, w, h, 8);
  const blobs = comps.filter((c) => {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    return bw >= 0.004 * w && bw <= 0.035 * w && bh >= 0.003 * w && bw / bh >= 0.8 && bw / bh <= 2.8 && c.area >= 0.45 * bw * bh;
  });
  if (blobs.length < 6) return false;
  const tol = 0.6 * median(blobs.map((c) => c.y1 - c.y0 + 1));
  let best = 0;
  for (let a = -10; a <= 10; a += 1) {
    const t = Math.tan(a * Math.PI / 180);
    const ys = blobs.map((c) => c.cy - t * c.cx).sort((x, y) => x - y);
    for (let i = 0, j = 0; i < ys.length; i++) { while (ys[i] - ys[j] > 2 * tol) j++; best = Math.max(best, i - j + 1); }
  }
  return best >= 6;
}
