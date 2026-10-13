// Utilidades de imagen en JS puro sobre <canvas> (sin librerías).

// Canvas con OffscreenCanvas si existe; si no, <canvas> del documento.
export function makeCanvas(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (typeof OffscreenCanvas !== 'undefined') {
    try { const c = new OffscreenCanvas(w, h); if (c.getContext('2d')) return c; } catch { /* sigue */ }
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

export const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

// Cede el hilo para no bloquear la UI.
export const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// Convierte la entrada (Blob/File/ImageBitmap/img/canvas) en canvas con lado mayor <= maxSide.
export async function loadToCanvas(input, maxSide = 2000) {
  let src = input; let close = null;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (typeof createImageBitmap === 'function') {
      try { src = await createImageBitmap(input, { imageOrientation: 'from-image' }); }
      catch { src = await createImageBitmap(input); }
      close = () => src.close && src.close();
    } else {
      src = await blobToImg(input);
    }
  } else if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement && !input.complete) {
    await new Promise((r, j) => { input.onload = r; input.onerror = j; });
  }
  const sw = src.naturalWidth || src.videoWidth || src.width; const sh = src.naturalHeight || src.videoHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * s); const h = Math.round(sh * s);
  // Reducción en pasos de /2 para evitar aliasing en fotos grandes.
  let cur = src; let cw = sw; let ch = sh;
  while (cw / 2 >= w * 1.0001 && ch / 2 >= h) {
    const nw = Math.round(cw / 2); const nh = Math.round(ch / 2);
    const t = makeCanvas(nw, nh); const g = ctx2d(t); g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, nw, nh);
    cur = t; cw = nw; ch = nh;
  }
  const c = makeCanvas(w, h); const g = ctx2d(c); g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, w, h);
  if (close) close();
  return c;
}

function blobToImg(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob); const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); }; im.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
    im.src = url;
  });
}

export function getRGBA(c) { return ctx2d(c).getImageData(0, 0, c.width, c.height).data; }

// Canvas desde un buffer gris (Uint8) o RGBA.
export function grayToCanvas(gray, w, h) {
  const c = makeCanvas(w, h); const g = ctx2d(c); const im = g.createImageData(w, h); const d = im.data;
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) { const v = gray[i]; d[j] = v; d[j + 1] = v; d[j + 2] = v; d[j + 3] = 255; }
  g.putImageData(im, 0, 0); return c;
}
export function rgbaToCanvas(rgba, w, h) {
  const c = makeCanvas(w, h); const g = ctx2d(c); const im = g.createImageData(w, h); im.data.set(rgba); g.putImageData(im, 0, 0); return c;
}

// Rota un canvas `deg` grados alrededor del centro (mismo tamaño, relleno con `fill`).
export function rotateCanvas(c, deg, fill = '#808080') {
  const o = makeCanvas(c.width, c.height); const g = ctx2d(o);
  g.fillStyle = fill; g.fillRect(0, 0, o.width, o.height);
  g.translate(o.width / 2, o.height / 2); g.rotate(deg * Math.PI / 180); g.translate(-c.width / 2, -c.height / 2);
  g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0);
  return o;
}

// Recorte (con escala opcional) de un canvas.
export function cropCanvas(c, x, y, w, h, scale = 1) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.max(1, Math.min(c.width - x, Math.ceil(w))); h = Math.max(1, Math.min(c.height - y, Math.ceil(h)));
  const o = makeCanvas(w * scale, h * scale); const g = ctx2d(o); g.imageSmoothingQuality = 'high';
  g.drawImage(c, x, y, w, h, 0, 0, o.width, o.height); return o;
}

// Luminancia (0..255) desde RGBA.
export function luminance(rgba) {
  const n = rgba.length >> 2; const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return out;
}

// Reducción por promedio de área (factor entero f) a RGB Float32 planar.
export function downsampleRGB(rgba, w, h, f) {
  const W = Math.floor(w / f); const H = Math.floor(h / f); const n = W * H;
  const R = new Float32Array(n); const G = new Float32Array(n); const B = new Float32Array(n); const k = 1 / (f * f);
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < f; dy++) {
        let j = ((Y * f + dy) * w + X * f) * 4;
        for (let dx = 0; dx < f; dx++, j += 4) { r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2]; }
      }
      const i = Y * W + X; R[i] = r * k; G[i] = g * k; B[i] = b * k;
    }
  }
  return { W, H, R, G, B };
}

// Mediana por canal en ventana (2r+1)^2 (imagen pequeña).
export function medianFilter(ch, W, H, r) {
  const out = new Float32Array(W * H); const buf = new Float32Array((2 * r + 1) * (2 * r + 1));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= H ? H - 1 : y + dy;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= W ? W - 1 : x + dx;
          buf[n++] = ch[yy * W + xx];
        }
      }
      out[y * W + x] = quickSelect(buf, n, n >> 1);
    }
  }
  return out;
}

function quickSelect(a, n, k) {
  let l = 0, r = n - 1;
  while (l < r) {
    const p = a[(l + r) >> 1]; let i = l, j = r;
    while (i <= j) {
      while (a[i] < p) i++;
      while (a[j] > p) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) r = j; else if (k >= i) l = i; else break;
  }
  return a[k];
}

// Fondo local (mediana a baja resolución) para cada canal.
export function backgroundModel(rgba, w, h, f, r) {
  const ds = downsampleRGB(rgba, w, h, f);
  return { f, W: ds.W, H: ds.H, R: medianFilter(ds.R, ds.W, ds.H, r), G: medianFilter(ds.G, ds.W, ds.H, r), B: medianFilter(ds.B, ds.W, ds.H, r) };
}

// "Tinta": distancia de cada píxel al color de fondo local más parecido de las celdas vecinas.
// Texto oscuro o claro sobre cualquier color → valor alto; rellenos y bordes de insignias → bajo.
// Los píxeles de borde (mezcla de dos fondos, p. ej. relleno de insignia y fondo blanco) se
// explican como mezcla: se usa la distancia al segmento entre el fondo más cercano y otro vecino.
export function inkMap(rgba, w, h, bg, rad = 2) {
  const { f, W, H, R, G, B } = bg; const out = new Float32Array(w * h);
  const ks = new Int32Array((2 * rad + 1) * (2 * rad + 1));
  for (let y = 0; y < h; y++) {
    const cy = Math.min(H - 1, Math.floor(y / f));
    const y0 = Math.max(0, cy - rad); const y1 = Math.min(H - 1, cy + rad);
    for (let x = 0; x < w; x++) {
      const cx = Math.min(W - 1, Math.floor(x / f));
      const x0 = Math.max(0, cx - rad); const x1 = Math.min(W - 1, cx + rad);
      const j = (y * w + x) * 4; const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
      let best = 1e9, ka = -1, n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const k = yy * W + xx; ks[n++] = k;
          const dr = r - R[k], dg = g - G[k], db = b - B[k];
          const d = dr * dr + dg * dg + db * db; if (d < best) { best = d; ka = k; }
        }
      }
      if (best > 400) {
        // Distancia al segmento [a, b] para cada vecino b.
        const ar = R[ka], ag = G[ka], ab = B[ka]; const pr = r - ar, pg = g - ag, pb = b - ab;
        for (let i = 0; i < n; i++) {
          const k = ks[i]; const vr = R[k] - ar, vg = G[k] - ag, vb = B[k] - ab;
          const vv = vr * vr + vg * vg + vb * vb; if (vv < 900) continue;
          let t = (pr * vr + pg * vg + pb * vb) / vv; if (t <= 0) continue; if (t > 1) t = 1;
          const er = pr - t * vr, eg = pg - t * vg, eb = pb - t * vb;
          const d = er * er + eg * eg + eb * eb; if (d < best) best = d;
        }
      }
      out[y * w + x] = Math.sqrt(best);
    }
  }
  return out;
}

// Convierte el mapa de tinta en imagen gris (texto negro sobre blanco). Ganancia local: se divide
// por el máximo de tinta del entorno (≈3 alturas de texto), así el texto tenue (desenfocado, poco
// contraste, cabecera naranja) queda tan negro como el normal; el ruido de zonas lisas no se amplifica.
export function inkToGray(ink, w, h, cell = 10, lo = 18, hi = 90) {
  const W = Math.ceil(w / cell), H = Math.ceil(h / cell); const mx = new Float32Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = ((y / cell) | 0) * W + ((x / cell) | 0); const v = ink[y * w + x]; if (v > mx[k]) mx[k] = v; }
  // Máximo en ventana 5×5 celdas.
  const m2 = new Float32Array(W * H);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    let m = 0; for (let yy = Math.max(0, Y - 2); yy <= Math.min(H - 1, Y + 2); yy++) for (let xx = Math.max(0, X - 2); xx <= Math.min(W - 1, X + 2); xx++) if (mx[yy * W + xx] > m) m = mx[yy * W + xx];
    m2[Y * W + X] = m;
  }
  const out = new Uint8Array(w * h); const k = 255 / (hi - lo);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const lm = m2[((y / cell) | 0) * W + ((x / cell) | 0)];
    const v = (ink[i] * Math.min(2.5, Math.max(1, 150 / Math.max(lm, 40))) - lo) * k;
    out[i] = v <= 0 ? 255 : v >= 255 ? 0 : 255 - v;
  }
  return out;
}

// Luminancia "aplanada": divide por el fondo local (quita gradientes de luz y reflejos suaves).
export function flatLuminance(rgba, w, h, bg) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(bg.H - 1, Math.floor(y / bg.f));
    for (let x = 0; x < w; x++) {
      const c = cy * bg.W + Math.min(bg.W - 1, Math.floor(x / bg.f)); const j = (y * w + x) * 4;
      const L = 0.3 * rgba[j] + 0.59 * rgba[j + 1] + 0.11 * rgba[j + 2];
      const B = 0.3 * bg.R[c] + 0.59 * bg.G[c] + 0.11 * bg.B[c];
      // Fondo casi negro (marco del móvil, mesa): no hay texto de la app → blanco (no estropea el Otsu de Tesseract).
      if (B < 55) { out[y * w + x] = 255; continue; }
      const v = 255 * L / (B * 0.92); out[y * w + x] = v > 255 ? 255 : v;
    }
  }
  return out;
}

// Desenfoque de caja separable (radio r) sobre un buffer gris.
export function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h); const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    let acc = 0; const o = y * w;
    for (let x = -r; x <= r; x++) acc += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[o + x] = acc * k; acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = acc * k; acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}

// Máscara de enfoque (unsharp): realza bordes suaves de fotos algo movidas.
export function unsharp(gray, w, h, r = 2, amount = 0.8) {
  const b = boxBlur(gray, w, h, r); const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) { const v = gray[i] + amount * (gray[i] - b[i]); out[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
  return out;
}

// Fondo "neutro": color medio por celda de los píxeles con la cromaticidad del fondo de la lista
// (o casi grises) y mediana en ventana: no se contamina con el color de las insignias.
// Sirve para el equilibrio de color local.
export function neutralBackground(rgba, w, h, f, r, rect = null) {
  const W = Math.floor(w / f), H = Math.floor(h / f), n = W * H;
  // Solo las celdas dentro del rectángulo (+ margen de la ventana) se calculan.
  const pad = (r + 1) * f;
  const X0 = rect ? Math.max(0, Math.floor((rect.x0 - pad) / f)) : 0, X1 = rect ? Math.min(W - 1, Math.ceil((rect.x1 + pad) / f)) : W - 1;
  const Y0 = rect ? Math.max(0, Math.floor((rect.y0 - pad) / f)) : 0, Y1 = rect ? Math.min(H - 1, Math.ceil((rect.y1 + pad) / f)) : H - 1;
  const cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n), ok = new Uint8Array(n);
  // Cromaticidad de referencia: mediana de los píxeles claros (el fondo de la lista, aunque esté teñido).
  const inR = (j) => { if (!rect) return true; const p = j >> 2, x = p % w, y = (p / w) | 0; return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1; };
  const bv = [];
  for (let j = 0; j < rgba.length; j += 16) if (inR(j)) bv.push(Math.max(rgba[j], rgba[j + 1], rgba[j + 2]));
  bv.sort((a, b) => a - b); const bthr = bv[Math.floor(bv.length * 0.6)] || 0;
  const rr = [], rg = [];
  for (let j = 0; j < rgba.length; j += 16) {
    if (!inR(j)) continue;
    const R = rgba[j], G = rgba[j + 1], B = rgba[j + 2]; if (Math.max(R, G, B) < bthr) continue;
    const t = R + G + B + 1e-3; rr.push(R / t); rg.push(G / t);
  }
  rr.sort((a, b) => a - b); rg.sort((a, b) => a - b);
  const refR = rr.length ? rr[rr.length >> 1] : 1 / 3, refG = rg.length ? rg[rg.length >> 1] : 1 / 3;
  for (let Y = Y0; Y <= Y1; Y++) {
    for (let X = X0; X <= X1; X++) {
      let sr = 0, sg = 0, sb = 0, c = 0;
      for (let dy = 0; dy < f; dy++) {
        let j = ((Y * f + dy) * w + X * f) * 4;
        for (let dx = 0; dx < f; dx++, j += 4) {
          const R = rgba[j], G = rgba[j + 1], B = rgba[j + 2]; const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          if (mx < 50) continue;
          const t = R + G + B; const dr = R / t - refR, dg = G / t - refG;
          if (dr * dr + dg * dg < 0.045 * 0.045 || (mx - mn) < 0.12 * mx) { sr += R; sg += G; sb += B; c++; }
        }
      }
      const i = Y * W + X;
      if (c >= f * f * 0.3) { cr[i] = sr / c; cg[i] = sg / c; cb[i] = sb / c; ok[i] = 1; }
    }
  }
  const oR = new Float32Array(n), oG = new Float32Array(n), oB = new Float32Array(n);
  const br = [], bgc = [], bb = [];
  for (let i = 0; i < n; i++) if (ok[i]) { br.push(cr[i]); bgc.push(cg[i]); bb.push(cb[i]); }
  const gm = (a) => (a.length ? quickSelect(Float32Array.from(a), a.length, a.length >> 1) : 200);
  const gR = gm(br), gG = gm(bgc), gB = gm(bb);
  const buf = [new Float32Array((2 * r + 1) ** 2), new Float32Array((2 * r + 1) ** 2), new Float32Array((2 * r + 1) ** 2)];
  oR.fill(gR); oG.fill(gG); oB.fill(gB);
  for (let Y = Y0; Y <= Y1; Y++) {
    for (let X = X0; X <= X1; X++) {
      let k = 0;
      for (let yy = Math.max(0, Y - r); yy <= Math.min(H - 1, Y + r); yy++) {
        for (let xx = Math.max(0, X - r); xx <= Math.min(W - 1, X + r); xx++) {
          const i = yy * W + xx; if (!ok[i]) continue; buf[0][k] = cr[i]; buf[1][k] = cg[i]; buf[2][k] = cb[i]; k++;
        }
      }
      const i = Y * W + X;
      if (k >= 3) { oR[i] = quickSelect(buf[0], k, k >> 1); oG[i] = quickSelect(buf[1], k, k >> 1); oB[i] = quickSelect(buf[2], k, k >> 1); }
      else { oR[i] = gR; oG[i] = gG; oB[i] = gB; }
    }
  }
  return { f, W, H, R: oR, G: oG, B: oB };
}

// HSV aproximado de un color RGB (h en grados, s y v 0..1).
export function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx > 0 ? d / mx : 0, mx / 255];
}

export async function canvasToDataURL(c) {
  if (c.convertToBlob) {
    const blob = await c.convertToBlob({ type: 'image/png' });
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  }
  return c.toDataURL('image/png');
}
