// Overlay de depuración: foto con líneas/cuadrilátero a la izquierda y lista rectificada con filas a la derecha.
import { makeCanvas, toCanvas, canvasToDataURL } from './img.js';

export async function drawOverlay({ ana, sep, fam, quad, canon, rows, header, notes }) {
  const leftH = 900; const ls = leftH / ana.h; const lw = Math.round(ana.w * ls);
  const cs = canon ? Math.min(1, 900 / canon.img.w, 1400 / canon.img.h) : 1;
  const cw = canon ? Math.round(canon.img.w * cs) : 0, ch = canon ? Math.round(canon.img.h * cs) : 0;
  const W = lw + cw + 10, H = Math.max(leftH, ch) + 60;
  const c = makeCanvas(W, H); const x = c.getContext('2d');
  x.fillStyle = '#222'; x.fillRect(0, 0, W, H);
  x.drawImage(toCanvas(ana), 0, 0, lw, leftH);
  x.lineWidth = 1;
  if (sep) for (const L of sep.lines) { x.strokeStyle = 'rgba(255,255,0,0.35)'; line(x, L.x0 * ls, (L.a * L.x0 + L.b) * ls, L.x1 * ls, (L.a * L.x1 + L.b) * ls); }
  if (fam) for (const L of fam.lines) {
    x.strokeStyle = '#0f0'; x.lineWidth = 2; line(x, L.x0 * ls, (L.fa * L.x0 + L.fb) * ls, L.x1 * ls, (L.fa * L.x1 + L.fb) * ls);
    for (const e of [L.edgeL, L.edgeR]) if (e) { x.fillStyle = e.border ? '#f80' : '#f00'; x.fillRect(e.x * ls - 3, e.y * ls - 3, 6, 6); }
  }
  if (fam && fam.scan) for (const e of fam.scan) { x.fillStyle = e.border ? '#fa0' : '#f0f'; x.fillRect(e.x * ls - 2, e.y * ls - 2, 4, 4); }
  if (quad) {
    x.strokeStyle = '#0ff'; x.lineWidth = 2; x.beginPath();
    const P = [quad.TL, quad.TR, quad.BR, quad.BL].map((p) => [p[0] * ls, p[1] * ls]);
    x.moveTo(...P[0]); for (const p of P.slice(1)) x.lineTo(...p); x.closePath(); x.stroke();
  }
  if (canon) {
    const ox = lw + 10;
    x.drawImage(toCanvas(canon.img), ox, 0, cw, ch);
    const V = (v) => (v - canon.v0) / canon.step * cs; const U = (u) => ox + (u - canon.u0) / canon.step * cs;
    if (header) {
      x.strokeStyle = '#f0f'; x.lineWidth = 2; line(x, U(0), V(header.vBottom), U(canon.W), V(header.vBottom));
      if (header.monthBox) { const b = header.monthBox; x.strokeStyle = '#ff0'; x.strokeRect(U(b.u0), V(b.v0), (b.u1 - b.u0) / canon.step * cs, (b.v1 - b.v0) / canon.step * cs); }
      x.fillStyle = '#ff0'; x.font = '14px sans-serif'; x.fillText(String(header.text || '').slice(0, 40), U(0) + 4, V(header.vBottom) - 4);
    }
    if (canon.peaks) for (const p of canon.peaks) { x.strokeStyle = 'rgba(255,0,0,0.6)'; x.lineWidth = 1; line(x, U(canon.W * 0.92), V(p.v), U(canon.W), V(p.v)); }
    for (const r of rows || []) {
      x.strokeStyle = r.ok ? '#0f0' : '#888'; x.lineWidth = 1; x.strokeRect(U(0) + 1, V(r.v0), cw - 2, (r.v1 - r.v0) / canon.step * cs);
      for (const b of r.blobs || []) { x.strokeStyle = b.kind === 'text' ? '#0af' : '#f0f'; x.strokeRect(U(b.u0), V(b.v0), (b.u1 - b.u0) / canon.step * cs, (b.v1 - b.v0) / canon.step * cs); }
      x.font = 'bold 13px sans-serif'; x.fillStyle = '#000'; const t = r.label || '';
      x.fillText(t, U(canon.W * 0.45) + 1, V(r.v0) + 15); x.fillStyle = r.ok ? '#c00' : '#555'; x.fillText(t, U(canon.W * 0.45), V(r.v0) + 14);
    }
  }
  x.fillStyle = '#fff'; x.font = '13px monospace';
  (notes || []).slice(0, 3).forEach((n, i) => x.fillText(String(n).slice(0, 160), 4, H - 44 + i * 15));
  return canvasToDataURL(c);
}

function line(x, a, b, c, d) { x.beginPath(); x.moveTo(a, b); x.lineTo(c, d); x.stroke(); }

// Hoja con los recortes enviados al OCR y su lectura.
export async function drawCrops(list) {
  const H = 60; const items = list.map((c) => ({ ...c, w: Math.round(c.im.w * H / c.im.h) }));
  const cols = 4; const cw = Math.max(...items.map((c) => c.w), 120) + 170; const rows = Math.ceil(items.length / cols);
  const cv = makeCanvas(cols * cw, rows * (H + 6)); const x = cv.getContext('2d');
  x.fillStyle = '#ccc'; x.fillRect(0, 0, cv.width, cv.height);
  items.forEach((c, i) => {
    const ox = (i % cols) * cw, oy = Math.floor(i / cols) * (H + 6);
    x.drawImage(toCanvas(c.im), ox, oy, c.w, H);
    x.fillStyle = '#000'; x.font = '13px monospace'; x.fillText(c.label.slice(0, 22), ox + c.w + 4, oy + 30);
  });
  return canvasToDataURL(cv);
}
