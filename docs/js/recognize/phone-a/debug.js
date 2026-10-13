// Dibujo de la superposición de depuración (solo con options.debug).
import { makeCanvas, ctx2d, CLASS_RGB, freeCanvas } from './img.js';

async function toDataURL(c) {
  if (c.toDataURL) return c.toDataURL('image/png');
  const blob = await c.convertToBlob({ type: 'image/png' });
  return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}

export async function drawOverlay(canvas, px, cls, dbg) {
  const W = dbg.W, H = dbg.H;
  const CW = 360; const out = makeCanvas(W * 2 + CW, H); const g = ctx2d(out);
  // izquierda: imagen corregida; derecha: mapa de clases
  const id = g.createImageData(W, H); id.data.set(px); g.putImageData(id, 0, 0);
  const cm = g.createImageData(W, H);
  for (let p = 0; p < W * H; p++) { const c = CLASS_RGB[cls[p]]; const i = p * 4; cm.data[i] = c[0]; cm.data[i + 1] = c[1]; cm.data[i + 2] = c[2]; cm.data[i + 3] = cls[p] ? 255 : 255; if (!cls[p]) { cm.data[i] = cm.data[i + 1] = cm.data[i + 2] = 128; } }
  g.putImageData(cm, W, 0);
  g.lineWidth = 2; g.font = `${Math.max(12, Math.round((dbg.D || 40) * 0.32))}px sans-serif`;
  const fr = dbg.frame;
  if (dbg.header && fr) { const h = dbg.header; g.strokeStyle = '#f80'; g.lineWidth = 3; g.beginPath(); g.moveTo(...fr.xy(h.u0, h.vb)); g.lineTo(...fr.xy(h.u1, h.vb)); g.stroke(); g.lineWidth = 2; }
  if (fr && dbg.line) {
    // línea de columna
    g.strokeStyle = '#0a0'; g.beginPath();
    for (let v = 0; v < H * 1.5; v += 20) { const [x, y] = fr.xy(dbg.line.at(v), v); if (v === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
  }
  for (const r of dbg.rows || []) {
    if (!fr) break;
    const [x0, y0] = fr.xy(r.uFirst - 2.2 * dbg.D, r.v), [x1, y1] = fr.xy(r.uFirst + 4 * dbg.D, r.v);
    g.strokeStyle = r.ok === false ? '#f00' : (r.colOk ? '#00f' : '#f0f'); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    for (const it of r.items) {
      g.strokeStyle = it.kind === 'badge' ? '#000' : '#f00';
      const s = (it.size || 10) / 2; g.strokeRect(it.cx - s, it.cy - s, 2 * s, 2 * s);
    }
    if (r.label) { g.fillStyle = '#000'; g.fillText(r.label, x1 - 3 * dbg.D, y1 - 4); g.fillStyle = '#ff0'; g.fillText(r.label, x1 - 3 * dbg.D + 1, y1 - 5); }
    for (const box of r.boxes || []) { g.strokeStyle = box.color || '#0aa'; g.beginPath(); box.pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke(); }
  }
  for (const c of dbg.comps || []) { g.strokeStyle = c.kind ? '#f60' : '#999'; g.strokeRect(c.cx - 4, c.cy - 4, 8, 8); }
  for (const t of dbg.texts || []) { g.fillStyle = '#000'; g.fillText(t.s, t.x + 1, t.y + 1); g.fillStyle = t.color || '#fff'; g.fillText(t.s, t.x, t.y); }
  g.fillStyle = '#000'; g.fillRect(W, 0, W, 22 * (dbg.notes.length + 1));
  g.fillStyle = '#fff'; g.font = '16px sans-serif';
  const notes = [`D=${dbg.D && dbg.D.toFixed(1)} tilt=${dbg.tilt ? (dbg.tilt.theta * 180 / Math.PI).toFixed(1) + '° ' + dbg.tilt.src + ' n=' + dbg.tilt.n : '-'} wb=${dbg.wb.gains.map((x) => x.toFixed(2)).join(',')}`, ...dbg.notes];
  notes.forEach((s, i) => g.fillText(s, W + 6, 18 + i * 22));
  // columna de recortes enviados al OCR
  g.fillStyle = '#fff'; g.fillRect(2 * W, 0, CW, H);
  let y = 2; g.font = '13px sans-serif';
  for (const c of dbg.crops || []) {
    const k = Math.min(1, (CW - 150) / c.canvas.width, 40 / c.canvas.height);
    const cw = Math.max(1, Math.round(c.canvas.width * k)), ch = Math.max(1, Math.round(c.canvas.height * k));
    if (y + ch > H) break;
    g.drawImage(c.canvas, 2 * W + 2, y, cw, ch);
    g.fillStyle = '#000'; g.fillText(c.label.slice(0, 26), 2 * W + cw + 6, y + Math.min(ch, 30) / 2 + 5);
    y += ch + 3;
    freeCanvas(c.canvas);
  }
  const url = await toDataURL(out); freeCanvas(out);
  return url;
}
