// Utilidades de imagen puras (sin DOM). Imagen = { w, h, data: Uint8ClampedArray RGBA }.

export function makeImage(w, h) { return { w, h, data: new Uint8ClampedArray(w * h * 4) }; }

export function toGray(img) {
  const { data } = img; const g = new Float32Array(img.w * img.h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return g;
}

// Reducción por promedio de área (factor arbitrario ≥ 1), separable.
export function downscale(img, scale) {
  if (scale >= 0.999) return img;
  const W = img.w, H = img.h; const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const fx = W / w, fy = H / h;
  const tmp = new Float32Array(w * H * 4);
  for (let x = 0; x < w; x++) {
    const a = x * fx, b = a + fx; const i0 = Math.floor(a), i1 = Math.min(W, Math.ceil(b));
    for (let i = i0; i < i1; i++) {
      const wt = Math.min(b, i + 1) - Math.max(a, i);
      if (wt <= 0) continue;
      for (let y = 0; y < H; y++) {
        const s = (y * W + i) * 4, d = (y * w + x) * 4;
        tmp[d] += img.data[s] * wt; tmp[d + 1] += img.data[s + 1] * wt; tmp[d + 2] += img.data[s + 2] * wt; tmp[d + 3] += img.data[s + 3] * wt;
      }
    }
  }
  const out = makeImage(w, h); const acc = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    const a = y * fy, b = a + fy; const j0 = Math.floor(a), j1 = Math.min(H, Math.ceil(b));
    for (let x = 0; x < w; x++) {
      acc.fill(0);
      for (let j = j0; j < j1; j++) {
        const wt = Math.min(b, j + 1) - Math.max(a, j);
        if (wt <= 0) continue;
        const s = (j * w + x) * 4;
        acc[0] += tmp[s] * wt; acc[1] += tmp[s + 1] * wt; acc[2] += tmp[s + 2] * wt; acc[3] += tmp[s + 3] * wt;
      }
      const d = (y * w + x) * 4; const k = 1 / (fx * fy);
      out.data[d] = acc[0] * k; out.data[d + 1] = acc[1] * k; out.data[d + 2] = acc[2] * k; out.data[d + 3] = acc[3] * k;
    }
  }
  return out;
}

// Muestreo bilineal de un canal gris (Float32Array) con borde recortado.
export function sampleGray(g, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
  if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0; const i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
}

// Rectifica: para cada píxel de salida (u, v) = (u0 + i·step, v0 + j·step) en el plano canónico,
// toma la muestra bilineal de src en H·(u, v). Fuera de la imagen → alfa 0.
export function warp(src, H, outW, outH, u0, v0, step) {
  const out = makeImage(outW, outH); const d = out.data; const s = src.data; const W = src.w, Hh = src.h;
  for (let j = 0; j < outH; j++) {
    const v = v0 + j * step;
    for (let i = 0; i < outW; i++) {
      const u = u0 + i * step;
      const zw = H[6] * u + H[7] * v + H[8];
      const o = (j * outW + i) * 4;
      if (zw <= 1e-9) continue;
      const x = (H[0] * u + H[1] * v + H[2]) / zw, y = (H[3] * u + H[4] * v + H[5]) / zw;
      if (x < 0 || y < 0 || x > W - 1.001 || y > Hh - 1.001) continue;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const p = (y0 * W + x0) * 4, q = p + W * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      d[o] = s[p] * w00 + s[p + 4] * w10 + s[q] * w01 + s[q + 4] * w11;
      d[o + 1] = s[p + 1] * w00 + s[p + 5] * w10 + s[q + 1] * w01 + s[q + 5] * w11;
      d[o + 2] = s[p + 2] * w00 + s[p + 6] * w10 + s[q + 2] * w01 + s[q + 6] * w11;
      d[o + 3] = 255;
    }
  }
  return out;
}

// RGB (0..255) → [h 0..360, s 0..1, v 0..255]
export function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx];
}

// Umbral de Otsu sobre valores (array numérico) en [lo, hi].
export function otsu(vals, lo = 0, hi = 255, bins = 64) {
  const hist = new Float64Array(bins); const sc = (bins - 1) / Math.max(1e-6, hi - lo);
  for (const v of vals) hist[Math.max(0, Math.min(bins - 1, Math.round((v - lo) * sc)))]++;
  const tot = vals.length; let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, th = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = tot - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; th = i; }
  }
  return lo + (th + 0.5) / sc;
}

// Componentes conexas (8-vecindad) de una máscara Uint8Array w×h.
// Devuelve { labels: Int32Array, comps: [{id, area, x0, y0, x1, y1, sx, sy}] }
export function components(mask, w, h, minArea = 1) {
  const labels = new Int32Array(w * h); const comps = []; const stack = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    next++;
    let sp = 0; stack[sp++] = i; labels[i] = next;
    let area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, sx = 0, sy = 0;
    while (sp) {
      const p = stack[--sp]; const x = p % w, y = (p / w) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !labels[q]) { labels[q] = next; stack[sp++] = q; }
        }
      }
    }
    comps.push({ id: next, area, x0, y0, x1, y1, cx: sx / area, cy: sy / area });
  }
  return { labels, comps: comps.filter((c) => c.area >= minArea) };
}

// Rellena agujeros de la componente `id` dentro de su caja: devuelve máscara local (Uint8Array bw×bh).
export function filledMask(labels, w, comp) {
  const bw = comp.x1 - comp.x0 + 3, bh = comp.y1 - comp.y0 + 3; // margen 1 px
  const m = new Uint8Array(bw * bh);
  for (let y = comp.y0; y <= comp.y1; y++) for (let x = comp.x0; x <= comp.x1; x++) if (labels[y * w + x] === comp.id) m[(y - comp.y0 + 1) * bw + (x - comp.x0 + 1)] = 1;
  // inundación desde el borde exterior
  const ext = new Uint8Array(bw * bh); const st = [0]; ext[0] = 1;
  while (st.length) {
    const p = st.pop(); const x = p % bw, y = (p / bw) | 0;
    const nb = [p - 1, p + 1, p - bw, p + bw];
    for (let k = 0; k < 4; k++) {
      const q = nb[k];
      if (k === 0 && x === 0) continue; if (k === 1 && x === bw - 1) continue;
      if (q < 0 || q >= bw * bh) continue;
      if (!m[q] && !ext[q]) { ext[q] = 1; st.push(q); }
    }
  }
  const out = new Uint8Array(bw * bh);
  for (let i = 0; i < out.length; i++) out[i] = ext[i] ? 0 : 1;
  return { mask: out, bw, bh, ox: comp.x0 - 1, oy: comp.y0 - 1 };
}

// Gira la imagen k cuartos de vuelta en sentido horario (k = 1, 2, 3).
export function rotateQuarter(img, k) {
  const { w, h, data } = img; const W = k % 2 ? h : w, H = k % 2 ? w : h;
  const out = makeImage(W, H); const o = new Uint32Array(out.data.buffer); const s = new Uint32Array(data.buffer, data.byteOffset, w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let X, Y;
    if (k === 1) { X = h - 1 - y; Y = x; } else if (k === 2) { X = w - 1 - x; Y = h - 1 - y; } else { X = y; Y = w - 1 - x; }
    o[Y * W + X] = s[y * w + x];
  }
  return out;
}
