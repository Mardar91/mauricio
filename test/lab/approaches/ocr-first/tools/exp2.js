// Funciones de depuración para tools/probe.mjs (no forman parte del reconocedor).
import * as I from '../img.js';
import { findROI } from '../layout.js';
import { recognize } from '../recognize.js';

// Ejecuta el reconocedor y devuelve los renders de insignias (raw + render) para inspección.
export async function renders(blob, { tesseract, arg }) {
  const res = await recognize(blob, { tesseract, debug: true, debugRenders: true });
  const images = {};
  for (const [i, r] of (res.debug.renders || []).entries()) {
    if (arg?.row && r.row !== arg.row) continue;
    images[`r${r.row}_${i}_${r.cls}_raw`] = r.raw; images[`r${r.row}_${i}_${r.cls}_${r.mode}`] = r.img;
  }
  return { images, data: res.days };
}

export async function info(blob, { tesseract, arg }) {
  const res = await recognize(blob, { tesseract, debug: true });
  const d = res.debug; const rows = arg?.rows;
  return { data: { H: d.H, days: res.days, comps: d.comps.filter((c) => !rows || rows.includes(c.row)).map((c) => JSON.stringify(c)).join('\n'), rows: d.rows.filter((r) => !rows || rows.includes(r.v)) } };
}

export async function roiMask(blob, { arg }) {
  const c = await I.loadToCanvas(blob, 2000); const rgba = I.getRGBA(c);
  const roi = findROI(rgba, c.width, c.height);
  const g = roi.grid; const out = new Uint8ClampedArray(g.W * g.H * 4);
  const stats = [];
  for (let i = 0; i < g.W * g.H; i++) {
    const [h, s, v] = I.rgbToHsv(g.R[i], g.G[i], g.B[i]);
    out[i * 4] = v * 255; out[i * 4 + 1] = s < 0.32 ? 255 : 0; out[i * 4 + 2] = g.S[i] < 40 ? 255 : 0; out[i * 4 + 3] = 255;
  }
  const col = Math.round(g.W * 0.6);
  for (let y = 0; y < g.H; y += 4) { const i = y * g.W + col; const [h, s, v] = I.rgbToHsv(g.R[i], g.G[i], g.B[i]); stats.push([y, Math.round(v * 255), +s.toFixed(2), Math.round(g.S[i])]); }
  return { images: { mask: await I.canvasToDataURL(I.rgbaToCanvas(out, g.W, g.H)) }, data: { roi: [roi.x, roi.y, roi.w, roi.h], f: roi.f, stats } };
}

// Captura sintética + reconocedor con depuración.
export async function synthDebug(_blob, { tesseract, arg }) {
  const S = await import('./synth.js');
  const { blob, truth } = await S.renderScreenshot(arg);
  const res = await recognize(blob, { tesseract, debug: true });
  const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  return { images: { ov: res.debug.overlay, src: url }, data: { truth, days: res.days, month: res.month, notes: res.debug.notes, rows: res.debug.rows.filter((r) => r.reject.length || (r.issues && r.issues.length)) } };
}
export async function synthRows(_b, { tesseract, arg }) {
  const S = await import('./synth.js'); const { blob } = await S.renderScreenshot(arg);
  const res = await recognize(blob, { tesseract, debug: true });
  return { data: res.debug.rows.map((r) => JSON.stringify(r)).join('\n') };
}
export async function transformDebug(blob, { tesseract, arg }) {
  const S = await import('./synth.js');
  const b2 = await S.transformPhoto(blob, arg);
  const res = await recognize(b2, { tesseract, debug: true });
  return { images: { ov: res.debug.overlay }, data: { days: res.days.map((d) => d.day + ':' + d.codes.join(' ')).join(', '), month: res.month, notes: res.debug.notes, rows: res.debug.rows.filter((r) => r.reject.length || (r.issues && r.issues.length)).map((r) => JSON.stringify(r)).join('\n'), comps: res.debug.comps.filter((c) => c.shape === 'letter' || (arg && arg.rows && arg.rows.includes(c.row))).map((c) => JSON.stringify(c)).join('\n') } };
}
export async function headerDebug(blob, { tesseract, arg }) {
  const S = await import('./synth.js');
  const b2 = arg ? await S.transformPhoto(blob, arg) : blob;
  const res = await recognize(b2, { tesseract, debug: true, debugRenders: true });
  return { images: res.debug.header ? { header: res.debug.header } : {}, data: res.debug.notes };
}
export async function timing(blob, { tesseract }) {
  const res = await recognize(blob, { tesseract, debug: true });
  return { data: res.debug.notes.filter((n) => n.startsWith('ms')) };
}

// Comprueba los tipos de entrada del contrato (Blob, File, ImageBitmap, <img>, <canvas>).
export async function inputTypes(blob, { tesseract }) {
  const out = {};
  const bmp = await createImageBitmap(blob);
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height; cv.getContext('2d').drawImage(bmp, 0, 0);
  const img = new Image(); img.src = URL.createObjectURL(blob);
  const file = new File([blob], 'x.jpg', { type: 'image/jpeg' });
  for (const [k, v] of Object.entries({ blob, file, bitmap: bmp, img, canvas: cv })) {
    const r = await recognize(v, { tesseract, onProgress: () => {} });
    out[k] = `${r.layout} ${r.month}/${r.year} ${r.days.length}`;
  }
  return { data: out };
}

// Sin OffscreenCanvas (como un Safari antiguo) y tras dispose().
export async function noOffscreen(blob, { tesseract }) {
  const M = await import('../recognize.js');
  await M.dispose();
  const saved = globalThis.OffscreenCanvas; globalThis.OffscreenCanvas = undefined;
  try {
    const r = await M.recognize(blob, { tesseract, debug: true });
    return { data: `${r.layout} ${r.month}/${r.year} ${r.days.map((d) => d.day + ':' + d.codes.join(' ')).join(', ')} overlay:${(r.debug.overlay || '').slice(0, 22)}` };
  } finally { globalThis.OffscreenCanvas = saved; }
}
