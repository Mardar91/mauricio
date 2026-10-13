// Utilidades de imagen del reconocedor "color-first": lienzos, carga, balance de blancos,
// clasificación de píxeles por color y componentes conexas. Sin dependencias.

// Clases de color
export const C_NONE = 0, C_Y = 1, C_G = 2, C_B = 3, C_M = 4, C_P = 5, C_R = 6, C_O = 7, C_K = 8, C_W = 9;
export const CLASS_NAMES = ['-', 'amarillo', 'verde', 'azul', 'magenta', 'rosa', 'rojo', 'naranja', 'tinta', 'blanco'];
export const CLASS_RGB = [[0, 0, 0], [240, 230, 0], [120, 190, 100], [50, 90, 190], [220, 0, 220], [245, 170, 185], [220, 30, 30], [240, 140, 20], [20, 20, 20], [255, 255, 255]];

let offscreenOk = null;
function canUseOffscreen() {
  if (offscreenOk === null) {
    try { offscreenOk = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d'); } catch (e) { offscreenOk = false; }
  }
  return offscreenOk;
}

// Lienzo 2D (OffscreenCanvas si existe; si no, <canvas>)
export function makeCanvas(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (canUseOffscreen()) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
export const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });
export function freeCanvas(c) { try { c.width = 1; c.height = 1; } catch (e) { /* nada */ } }

export const tick = () => new Promise((r) => setTimeout(r, 0));

// Decodifica la entrada (Blob/File/ImageBitmap/img/canvas) → { src, w, h, close }
export async function loadInput(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
      const url = URL.createObjectURL(input);
      try {
        const img = new Image(); img.decoding = 'async'; img.src = url;
        if (img.decode) await img.decode(); else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        if (img.naturalWidth > 0) return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
      } catch (e) { /* probamos createImageBitmap */ }
      URL.revokeObjectURL(url);
    }
    const bmp = await createImageBitmap(input);
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => { try { bmp.close(); } catch (e) { /* nada */ } } };
  }
  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    if (!input.complete || !input.naturalWidth) await (input.decode ? input.decode() : new Promise((r) => { input.onload = r; }));
    return { src: input, w: input.naturalWidth, h: input.naturalHeight, close: () => {} };
  }
  if (input && input.width > 0 && input.height > 0) return { src: input, w: input.width, h: input.height, close: () => {} };
  throw new Error('Imagen no válida');
}

// Copia reducida (lado mayor ≤ maxSide)
export function scaledCopy(src, sw, sh, maxSide) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = makeCanvas(w, h); const g = ctx2d(c);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  // reducción en pasos de ×2 como máximo para no perder detalle (aliasing)
  if (k < 0.5) {
    let cur = src, cw = sw, ch = sh;
    while (cw * 0.5 > w * 1.0001) {
      const nw = Math.max(w, Math.round(cw / 2)), nh = Math.max(h, Math.round(ch / 2));
      const t = makeCanvas(nw, nh); const tg = ctx2d(t); tg.imageSmoothingQuality = 'high';
      tg.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      if (cur !== src) freeCanvas(cur);
      cur = t; cw = nw; ch = nh;
    }
    g.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h);
    if (cur !== src) freeCanvas(cur);
  } else g.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
  return { canvas: c, w, h, k };
}

export function getPixels(c) { return ctx2d(c).getImageData(0, 0, c.width, c.height).data; }

// Tono (0-360), saturación (0-1) y valor de un píxel
export function hsv(r, g, b) {
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const c = mx - mn;
  let h = 0;
  if (c > 0) {
    if (mx === r) h = 60 * (((g - b) / c) % 6);
    else if (mx === g) h = 60 * ((b - r) / c + 2);
    else h = 60 * ((r - g) / c + 4);
    if (h < 0) h += 360;
  }
  return [h, mx > 0 ? c / mx : 0, mx, c];
}

// Clasifica un píxel (ya con balance de blancos: blanco de pantalla ≈ 235)
export function classifyPx(r, g, b) {
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const c = mx - mn;
  const y = (r * 77 + g * 150 + b * 29) >> 8;
  if (c < 18 || (c < 26 && mx > 150)) return y < 125 ? C_K : (y > 165 ? C_W : C_NONE);
  let h;
  if (mx === r) { h = 60 * (g - b) / c; if (h < 0) h += 360; } else if (mx === g) h = 60 * (b - r) / c + 120; else h = 60 * (r - g) / c + 240;
  const s = c / mx;
  // tolerancia a dominantes de color de la pantalla (fuera de los rosas)
  if (s < 0.2 && y > 120 && !(h >= 325 || h < 25)) return y > 165 ? C_W : C_NONE;
  if (h >= 47 && h < 78) { if (s >= 0.42 && mx >= 110) return C_Y; }
  else if (h >= 78 && h < 175) { if (s >= 0.15 && c >= 24 && mx >= 70) return C_G; }
  else if (h >= 190 && h < 258) { if (s >= 0.25 && c >= 34) return C_B; }
  else if (h >= 262 && h < 328) { if (s >= 0.32 && c >= 45) return C_M; }
  else if (h >= 18 && h < 47) { if (s >= 0.42 && mx >= 110) return C_O; }
  if (h >= 328 || h < 22) {
    if (s >= 0.42 && c >= 55) return C_R;
    if (s >= 0.09 && s < 0.45 && y >= 135) return C_P;
  }
  if (y < 100) return C_K;
  return C_NONE;
}

// Balance de blancos: muestrea el fondo alrededor de manchas muy saturadas (insignias, cabecera)
// y, si no hay, usa el modo cromático de los píxeles más claros. Devuelve ganancias por canal.
export function estimateWhite(px, w, h) {
  // 1) manchas saturadas con clasificación sin corregir
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 250000)));
  const sw = Math.ceil(w / step), sh = Math.ceil(h / step);
  const cls = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = ((y * step) * w + x * step) * 4;
    const k = classifyPx(px[i], px[i + 1], px[i + 2]);
    cls[y * sw + x] = (k === C_Y || k === C_M || k === C_B || k === C_O || k === C_G) ? k : 0;
  }
  const comps = labelComponents(cls, sw, sh, { minArea: 12, skip: (k) => k === 0 }).comps;
  const samples = [];
  for (const cc of comps) {
    const bw = cc.maxx - cc.minx + 1, bh = cc.maxy - cc.miny + 1;
    // solo manchas del tamaño de una insignia (no la cabecera ni objetos grandes)
    if (cc.area < 25 || cc.area / (bw * bh) < 0.5 || bw > 2 * bh || bh > 2 * bw || cc.area > sw * sh * 0.01) continue;
    const cx = cc.sx / cc.area, cy = cc.sy / cc.area;
    const rx = bw / 2, ry = bh / 2;
    for (let a = 0; a < 24; a++) {
      const t = (a / 24) * Math.PI * 2;
      for (const f of [1.25, 1.45]) {
        const x = Math.round((cx + Math.cos(t) * rx * f) * step), y = Math.round((cy + Math.sin(t) * ry * f) * step);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4; const r = px[i], g = px[i + 1], b = px[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < 60 || (mx - mn) > 0.4 * mx) continue;
        samples.push([r, g, b, r + g + b]);
      }
    }
  }
  let ref = null;
  if (samples.length >= 40) {
    // los más claros (el texto oscuro y sombras quedan fuera)
    samples.sort((a, b) => b[3] - a[3]);
    const top = samples.slice(0, Math.max(20, Math.round(samples.length * 0.5)));
    const med = (k) => { const v = top.map((s) => s[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
    ref = [med(0), med(1), med(2)];
  } else {
    // 2) modo cromático de los píxeles claros
    const ys = [];
    for (let i = 0; i < w * h * 4; i += 4 * step * 3) ys.push(px[i] + px[i + 1] + px[i + 2]);
    ys.sort((a, b) => a - b);
    const thr = ys[Math.floor(ys.length * 0.7)] || 0;
    const B = 40, hist = new Float64Array(B * B), acc = new Float64Array(B * B * 3);
    for (let i = 0; i < w * h * 4; i += 4 * step) {
      const r = px[i], g = px[i + 1], b = px[i + 2], s = r + g + b;
      if (s < thr || s < 150) continue;
      const cr = Math.min(B - 1, Math.max(0, Math.floor(((r / s) - 0.13) * B / 0.4)));
      const cb = Math.min(B - 1, Math.max(0, Math.floor(((b / s) - 0.13) * B / 0.4)));
      const k = cr * B + cb; hist[k]++; acc[k * 3] += r; acc[k * 3 + 1] += g; acc[k * 3 + 2] += b;
    }
    let best = -1, bv = 0;
    for (let k = 0; k < B * B; k++) if (hist[k] > bv) { bv = hist[k]; best = k; }
    if (best >= 0) ref = [acc[best * 3] / bv, acc[best * 3 + 1] / bv, acc[best * 3 + 2] / bv];
  }
  if (!ref) return { gains: [1, 1, 1], ref: null };
  const gains = ref.map((v) => Math.min(2.6, Math.max(0.75, 235 / Math.max(1, v))));
  return { gains, ref };
}

// Aplica ganancias → Uint8ClampedArray RGBA nuevo
export function applyGains(px, gains) {
  const out = new Uint8ClampedArray(px.length);
  const [gr, gg, gb] = gains;
  for (let i = 0; i < px.length; i += 4) { out[i] = px[i] * gr; out[i + 1] = px[i + 1] * gg; out[i + 2] = px[i + 2] * gb; out[i + 3] = 255; }
  return out;
}

export function classifyAll(px, w, h) {
  const cls = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) cls[p] = classifyPx(px[i], px[i + 1], px[i + 2]);
  return cls;
}

// Componentes conexas (8-conectividad) de píxeles con la misma clase.
// Devuelve { comps, labels } con estadísticas: área, caja, sumas y momentos de segundo orden.
export function labelComponents(cls, w, h, { minArea = 4, skip = (k) => k === C_NONE || k === C_W } = {}) {
  const labels = new Int32Array(w * h);
  let cap = 1 << 16; let parent = new Int32Array(cap); let next = 1;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } return a < b ? a : b; };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x; const k = cls[i];
      if (skip(k)) continue;
      let l = 0;
      if (x > 0 && cls[i - 1] === k) l = labels[i - 1];
      if (y > 0) {
        const up = i - w;
        if (cls[up] === k) l = l ? union(l, labels[up]) : labels[up];
        if (x > 0 && cls[up - 1] === k) l = l ? union(l, labels[up - 1]) : labels[up - 1];
        if (x < w - 1 && cls[up + 1] === k) l = l ? union(l, labels[up + 1]) : labels[up + 1];
      }
      if (!l) {
        if (next >= cap) { const np = new Int32Array(cap * 2); np.set(parent); parent = np; cap *= 2; }
        parent[next] = next; l = next++;
      }
      labels[i] = l;
    }
  }
  // compacta etiquetas
  const remap = new Int32Array(next); let n = 0;
  for (let l = 1; l < next; l++) { const r = find(l); if (r === l) remap[l] = ++n; }
  for (let l = 1; l < next; l++) remap[l] = remap[find(l)];
  const area = new Int32Array(n + 1), minx = new Int32Array(n + 1).fill(1e9), maxx = new Int32Array(n + 1).fill(-1);
  const miny = new Int32Array(n + 1).fill(1e9), maxy = new Int32Array(n + 1).fill(-1), klass = new Uint8Array(n + 1);
  const sx = new Float64Array(n + 1), sy = new Float64Array(n + 1), sxx = new Float64Array(n + 1), syy = new Float64Array(n + 1), sxy = new Float64Array(n + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x; const l0 = labels[i]; if (!l0) continue;
      const l = remap[l0]; labels[i] = l;
      area[l]++; klass[l] = cls[i];
      if (x < minx[l]) minx[l] = x; if (x > maxx[l]) maxx[l] = x; if (y < miny[l]) miny[l] = y; if (y > maxy[l]) maxy[l] = y;
      sx[l] += x; sy[l] += y; sxx[l] += x * x; syy[l] += y * y; sxy[l] += x * y;
    }
  }
  const comps = [];
  for (let l = 1; l <= n; l++) {
    if (area[l] < minArea) continue;
    comps.push({ id: l, cls: klass[l], area: area[l], minx: minx[l], maxx: maxx[l], miny: miny[l], maxy: maxy[l], sx: sx[l], sy: sy[l], sxx: sxx[l], syy: syy[l], sxy: sxy[l] });
  }
  return { comps, labels };
}

// Forma de una componente: centro, ejes principales (desviaciones) y alargamiento
export function shapeOf(cc) {
  const n = cc.area, cx = cc.sx / n, cy = cc.sy / n;
  const vxx = cc.sxx / n - cx * cx, vyy = cc.syy / n - cy * cy, vxy = cc.sxy / n - cx * cy;
  const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const ang = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
  return { cx, cy, l1, l2, elong: Math.sqrt(l1 / l2), ang, bw: cc.maxx - cc.minx + 1, bh: cc.maxy - cc.miny + 1 };
}

// Umbral de Otsu sobre un histograma de 256 niveles
export function otsu(hist, total) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return { thr, sep: best / (total * total) };
}

// Balance de blancos local: referencia de fondo por bloques (píxeles claros y poco saturados),
// validada contra la global, suavizada e interpolada. Corrige degradados de color de la pantalla.
export function localWhite(px, w, h, globalRef, tile) {
  const T = Math.max(12, Math.round(tile));
  const gw = Math.ceil(w / T), gh = Math.ceil(h / T);
  const ref = new Float32Array(gw * gh * 3); const ok = new Uint8Array(gw * gh);
  const gY = 0.299 * globalRef[0] + 0.587 * globalRef[1] + 0.114 * globalRef[2];
  for (let ty = 0; ty < gh; ty++) for (let tx = 0; tx < gw; tx++) {
    const x0 = tx * T, y0 = ty * T, x1 = Math.min(w, x0 + T), y1 = Math.min(h, y0 + T);
    const ys = [];
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const i = (y * w + x) * 4; ys.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]); }
    ys.sort((a, b) => a - b);
    const thr = ys[Math.floor(ys.length * 0.6)];
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4; const R = px[i], G = px[i + 1], B = px[i + 2];
      const Y = 0.299 * R + 0.587 * G + 0.114 * B; if (Y < thr) continue;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B); if (mx - mn > 0.4 * mx) continue;
      r += R; g += G; b += B; n++;
    }
    const k = ty * gw + tx;
    if (n < ys.length * 0.15) continue;
    r /= n; g /= n; b /= n;
    const Y = 0.299 * r + 0.587 * g + 0.114 * b;
    // debe parecerse al blanco global (mismo tipo de fondo, no un objeto)
    const rr = (r / Y) / (globalRef[0] / gY), rg = (g / Y) / (globalRef[1] / gY), rb = (b / Y) / (globalRef[2] / gY);
    if (Y < 0.45 * gY || Y > 1.6 * gY || [rr, rg, rb].some((v) => v < 0.72 || v > 1.38)) continue;
    ref[k * 3] = r; ref[k * 3 + 1] = g; ref[k * 3 + 2] = b; ok[k] = 1;
  }
  // rellena huecos con vecinos válidos (varias pasadas) y si no, con la global
  for (let pass = 0; pass < 6; pass++) {
    let changed = false; const nok = ok.slice();
    for (let ty = 0; ty < gh; ty++) for (let tx = 0; tx < gw; tx++) {
      const k = ty * gw + tx; if (ok[k]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = ty + dy, xx = tx + dx; if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
        const q = yy * gw + xx; if (!ok[q]) continue; r += ref[q * 3]; g += ref[q * 3 + 1]; b += ref[q * 3 + 2]; n++;
      }
      if (n) { ref[k * 3] = r / n; ref[k * 3 + 1] = g / n; ref[k * 3 + 2] = b / n; nok[k] = 1; changed = true; }
    }
    ok.set(nok); if (!changed) break;
  }
  for (let k = 0; k < gw * gh; k++) if (!ok[k]) { ref[k * 3] = globalRef[0]; ref[k * 3 + 1] = globalRef[1]; ref[k * 3 + 2] = globalRef[2]; }
  // mediana 3×3 por canal (quita bloques dominados por una insignia)
  const med = new Float32Array(ref.length);
  for (let ty = 0; ty < gh; ty++) for (let tx = 0; tx < gw; tx++) for (let c = 0; c < 3; c++) {
    const v = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = Math.min(gh - 1, Math.max(0, ty + dy)), xx = Math.min(gw - 1, Math.max(0, tx + dx)); v.push(ref[(yy * gw + xx) * 3 + c]); }
    v.sort((a, b) => a - b); med[(ty * gw + tx) * 3 + c] = v[4];
  }
  const gainsAt = (x, y) => {
    const fx = Math.min(gw - 1, Math.max(0, x / T - 0.5)), fy = Math.min(gh - 1, Math.max(0, y / T - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = (1 - ay) * ((1 - ax) * med[(y0 * gw + x0) * 3 + c] + ax * med[(y0 * gw + x1) * 3 + c]) + ay * ((1 - ax) * med[(y1 * gw + x0) * 3 + c] + ax * med[(y1 * gw + x1) * 3 + c]);
      out[c] = Math.min(2.8, Math.max(0.7, 235 / Math.max(1, v)));
    }
    return out;
  };
  const apply = () => {
    const out = new Uint8ClampedArray(px.length);
    for (let y = 0; y < h; y++) {
      let g = gainsAt(0, y), nextX = 0;
      for (let x = 0; x < w; x++) {
        if (x >= nextX) { g = gainsAt(x + 4, y); nextX = x + 8; }
        const i = (y * w + x) * 4; out[i] = px[i] * g[0]; out[i + 1] = px[i + 1] * g[1]; out[i + 2] = px[i + 2] * g[2]; out[i + 3] = 255;
      }
    }
    return out;
  };
  return { gainsAt, apply, T, gw, gh };
}
