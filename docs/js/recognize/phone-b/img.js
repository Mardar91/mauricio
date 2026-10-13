// Carga de imágenes y lienzos (navegador). OffscreenCanvas si existe; si no, <canvas>.

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { const c = new OffscreenCanvas(w, h); if (c.getContext('2d')) return c; } catch { /* sigue */ }
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }

// Límite de lienzo de Safari iOS (16 777 216 px; getContext devuelve null por encima) y lado ≤ 4096
const fitsCanvas = (w, h) => Math.round(w) * Math.round(h) <= 16777216 && Math.max(Math.round(w), Math.round(h)) <= 4096;
const free = (c) => { try { c.width = 1; c.height = 1; } catch { /* nada */ } };

async function decode(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(input, { imageOrientation: 'from-image' }); } catch { /* sigue */ }
      try { return await createImageBitmap(input); } catch { /* sigue */ }
    }
    // respaldo: <img> con URL temporal (Safari antiguo)
    const url = URL.createObjectURL(input);
    try {
      const im = new Image(); im.decoding = 'async'; im.src = url;
      await (im.decode ? im.decode() : new Promise((res, rej) => { im.onload = res; im.onerror = rej; }));
      return im;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  return input; // ImageBitmap, HTMLImageElement, HTMLCanvasElement…
}

// Devuelve { w, h, data } con el lado mayor ≤ maxSide.
export async function loadRGBA(input, maxSide = 2000) {
  const src = await decode(input);
  const own = src !== input; // solo se cierra lo que se ha creado aquí
  const W = src.naturalWidth || src.videoWidth || src.width, H = src.naturalHeight || src.videoHeight || src.height;
  if (!W || !H) throw new Error('Imagen vacía o no válida');
  let s = Math.min(1, maxSide / Math.max(W, H));
  // reducción en pasos de ½ para evitar aliasing en factores grandes
  let cur = src, cw = W, ch = H;
  while (s < 0.5) {
    // paso de ½; si no cabe en un lienzo de iPhone (foto enorme), de ¼, ⅛…
    let f = 2;
    while (s * f < 0.5 && !fitsCanvas(cw / f, ch / f)) f *= 2;
    const nw = Math.round(cw / f), nh = Math.round(ch / f);
    const c = makeCanvas(nw, nh); const x = ctx2d(c); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh); if (cur !== src) free(cur); cur = c; cw = nw; ch = nh; s *= f;
  }
  const w = Math.round(cw * s), h = Math.round(ch * s);
  const c = makeCanvas(w, h); const x = ctx2d(c); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, w, h);
  if (cur !== src) free(cur);
  const id = x.getImageData(0, 0, w, h);
  if (own && src.close) try { src.close(); } catch { /* nada */ }
  return { w, h, data: id.data, origW: W, origH: H };
}

// Imagen {w,h,data} → lienzo
export function toCanvas(img) {
  const c = makeCanvas(img.w, img.h); const x = ctx2d(c);
  x.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.w * img.h * 4), img.w, img.h), 0, 0);
  return c;
}

export async function canvasToDataURL(c, type = 'image/png') {
  if (c.toDataURL) return c.toDataURL(type);
  const blob = await c.convertToBlob({ type });
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
