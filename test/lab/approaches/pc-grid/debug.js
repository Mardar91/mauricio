// Dibujo de la superposición de depuración.
import { makeCanvas, ctx2d, canvasToDataURL } from './img.js';
import { at } from './lines.js';

export function makeOverlay(canvas, maxW = 1600) {
  const k = Math.min(1, maxW / canvas.width);
  const c = makeCanvas(canvas.width * k, canvas.height * k); const g = ctx2d(c);
  g.drawImage(canvas, 0, 0, c.width, c.height);
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, 0, c.width, c.height);
  return { c, g, k };
}

export function drawLine(o, l, color, width = 1) {
  const { g, k } = o;
  const [x0, y0] = at(l, l.a0); const [x1, y1] = at(l, l.a1);
  g.strokeStyle = color; g.lineWidth = width; g.beginPath(); g.moveTo(x0 * k, y0 * k); g.lineTo(x1 * k, y1 * k); g.stroke();
}

export function drawPoly(o, pts, color, width = 1) {
  const { g, k } = o;
  g.strokeStyle = color; g.lineWidth = width; g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)));
  g.closePath(); g.stroke();
}

// Coloca un lienzo pequeño (p. ej. la tabla rectificada) debajo de la imagen principal
export function stack(canvases, maxW = 1600) {
  let W = 0; let H = 0;
  const parts = canvases.filter(Boolean).map((c) => { const k = Math.min(1, maxW / c.width); const w = Math.round(c.width * k); const h = Math.round(c.height * k); W = Math.max(W, w); H += h + 4; return { c, w, h }; });
  const out = makeCanvas(W, H); const g = ctx2d(out); g.fillStyle = '#333'; g.fillRect(0, 0, W, H);
  let y = 0; for (const p of parts) { g.drawImage(p.c, 0, y, p.w, p.h); y += p.h + 4; }
  return out;
}

export const toDataURL = (c) => canvasToDataURL(c, 'image/png');
