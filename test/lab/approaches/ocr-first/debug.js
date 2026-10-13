// Dibujo de depuración: tokens, filas, insignias y resultado por fila.
import { makeCanvas, ctx2d, canvasToDataURL } from './img.js';

const CLS_COLOR = { yellow: '#c9b800', green: '#2e9e2e', blue: '#2350c8', magenta: '#d000d0', red: '#e00000', pink: '#ff7a9a' };

export async function drawOverlay(crop, dbg) {
  const W = crop.width, H = crop.height; const ex = 260; // margen derecho para notas
  // Hoja de recortes de insignias (render que ve el OCR + lecturas) debajo de la imagen.
  const sheet = (dbg.comps || []).filter((k) => k.render);
  const cellW = 270, cellH = 64, perRow = Math.max(1, Math.floor((W + ex) / cellW));
  const sheetH = sheet.length ? Math.ceil(sheet.length / perRow) * cellH + 8 : 0;
  const c = makeCanvas(W + ex, H + sheetH); const g = ctx2d(c);
  g.fillStyle = '#fff'; g.fillRect(0, 0, W + ex, H + sheetH);
  sheet.forEach((k, i) => {
    const x = (i % perRow) * cellW + 4, y = H + 6 + Math.floor(i / perRow) * cellH;
    const s = Math.min(1, (cellH - 8) / k.render.height, 110 / k.render.width);
    g.drawImage(k.render, x, y, k.render.width * s, k.render.height * s);
    g.fillStyle = '#000'; g.font = 'bold 12px sans-serif';
    g.fillText(`${k.row ?? ''} ${k.cls} → ${k.decoded ? k.decoded.code || '?' : '-'}`, x + 114, y + 12);
    g.font = '11px sans-serif'; g.fillStyle = '#444';
    wrap(g, (k.readings || []).map((r) => `${r.text}:${Math.round(r.conf)}`).join(' '), x + 114, y + 26, cellW - 120);
  });
  g.drawImage(crop, 0, 0); g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(0, 0, W, H);
  g.font = '13px sans-serif'; g.lineWidth = 1.5;
  for (const t of dbg.tokens || []) {
    const col = t.kind === 'day' ? '#0000ff' : t.kind === 'wd' ? '#008800' : t.kind === 'month' || t.kind === 'year' ? '#ff8800' : '#999';
    g.strokeStyle = col; g.strokeRect(t.x0, t.y0, t.x1 - t.x0, t.y1 - t.y0);
    if (t.kind !== 'other' || t.conf > 50) { g.fillStyle = col; g.fillText(`${t.text}·${Math.round(t.conf)}`, t.x1 + 1, t.y0 + 10); }
  }
  if (dbg.col) {
    g.strokeStyle = 'rgba(0,0,255,0.35)'; g.beginPath(); g.moveTo(dbg.col.a, 0); g.lineTo(dbg.col.a + dbg.col.b * H, H); g.stroke();
  }
  if (dbg.headerBottom > 0) { g.strokeStyle = '#ff8800'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, dbg.headerBottom); g.lineTo(W, dbg.headerBottom); g.stroke(); g.setLineDash([]); }
  for (const c2 of dbg.comps || []) {
    g.strokeStyle = CLS_COLOR[c2.cls] || '#000'; g.lineWidth = c2.shape === 'noise' ? 1 : 2.5;
    g.strokeRect(c2.x0, c2.y0, c2.w, c2.h);
    if (c2.shape !== 'noise') {
      g.fillStyle = '#000'; const lab = c2.decoded ? (c2.decoded.code || '?') : c2.shape;
      g.fillText(lab, c2.x0, c2.y1 + 12);
      if (c2.readings) { g.fillStyle = '#555'; g.fillText(c2.readings.map((r) => r.text).join(' ').slice(0, 40), c2.x1 + 3, c2.y0 + 22); }
    }
  }
  g.lineWidth = 1;
  for (const r of dbg.rows || []) {
    if (r.top == null) continue;
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.moveTo(0, r.top); g.lineTo(W, r.top); g.stroke();
    if (r.band) { g.strokeStyle = 'rgba(0,150,255,0.6)'; g.strokeRect(r.band.x0, r.band.y0, r.band.x1 - r.band.x0, r.band.y1 - r.band.y0); }
    const ok = !r.reject.length && r.issues && !r.issues.length;
    g.fillStyle = ok ? '#006600' : '#cc0000';
    g.font = 'bold 15px sans-serif';
    const txt = ok ? `${r.v}: ${r.codes.join(' ') || '[]'}` : `${r.v}: ✗ ${[...r.reject, ...(r.issues || [])].join(', ')}`;
    wrap(g, txt, W + 4, r.y, ex - 8);
    g.font = '13px sans-serif';
  }
  g.fillStyle = '#000'; let y = 14;
  for (const n of [`ángulo ${dbg.angle}°  H=${dbg.H ? dbg.H.toFixed(1) : '?'}`, ...(dbg.notes || [])]) { wrap(g, n, W + 4, y, ex - 8); y += 30; }
  // Reducir si es muy grande.
  const s = Math.min(1, 1100 / c.width);
  if (s < 1) { const o = makeCanvas(c.width * s, c.height * s); ctx2d(o).drawImage(c, 0, 0, o.width, o.height); return canvasToDataURL(o); }
  return canvasToDataURL(c);
}

function wrap(g, text, x, y, maxW) {
  const words = String(text).split(' '); let line = ''; let yy = y;
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > maxW && line) { g.fillText(line, x, yy); line = w; yy += 15; } else line = t;
  }
  if (line) g.fillText(line, x, yy);
}
