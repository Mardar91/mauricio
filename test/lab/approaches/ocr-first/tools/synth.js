// Generadores sintéticos (solo para pruebas de robustez; se ejecutan en el navegador).
// - transformPhoto: perturba una foto real (giro, escala, perspectiva, color, desenfoque, JPEG…).
// - renderScreenshot: dibuja una captura limpia tipo "Dienstplan" con verdad conocida.

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.round(w); c.height = Math.round(h); return c; };
const toBlob = (c, q = 0.92) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

// Generador pseudoaleatorio reproducible.
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export async function transformPhoto(blob, t = {}) {
  const bmp = await createImageBitmap(blob);
  let c = mk(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
  // Perspectiva (trapecio): tiras horizontales con ancho variable.
  if (t.keystone) {
    const k = t.keystone; const o = mk(c.width, c.height); const g = o.getContext('2d');
    g.fillStyle = '#333'; g.fillRect(0, 0, o.width, o.height);
    const strips = 200; const sh = c.height / strips;
    for (let i = 0; i < strips; i++) {
      const f = 1 - k * (1 - i / strips); const w = c.width * f; // arriba más estrecho si k>0
      g.drawImage(c, 0, i * sh, c.width, sh + 1, (c.width - w) / 2, i * sh, w, sh + 1);
    }
    c = o;
  }
  // Giro sobre un lienzo mayor (no se recorta nada).
  if (t.rotate) {
    const a = t.rotate * Math.PI / 180; const W = Math.abs(c.width * Math.cos(a)) + Math.abs(c.height * Math.sin(a)); const H = Math.abs(c.width * Math.sin(a)) + Math.abs(c.height * Math.cos(a));
    const o = mk(W, H); const g = o.getContext('2d'); g.fillStyle = t.bg || '#3a3a3a'; g.fillRect(0, 0, W, H);
    g.translate(W / 2, H / 2); g.rotate(a); g.drawImage(c, -c.width / 2, -c.height / 2); c = o;
  }
  // Escala + marco (simula foto grande de 12 MP con el móvil más pequeño en el encuadre).
  if (t.scale || t.frame) {
    const s = t.scale || 1; const fr = t.frame || 0;
    const o = mk(c.width * s * (1 + 2 * fr), c.height * s * (1 + 2 * fr)); const g = o.getContext('2d');
    g.fillStyle = t.bg || '#5a4a3a'; g.fillRect(0, 0, o.width, o.height);
    // textura de fondo
    const r = rng(7); for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(${(r() * 255) | 0},${(r() * 255) | 0},${(r() * 255) | 0},0.25)`; g.fillRect(r() * o.width, r() * o.height, 3 + r() * 12, 3 + r() * 12); }
    g.imageSmoothingQuality = 'high'; g.drawImage(c, c.width * s * fr, c.height * s * fr, c.width * s, c.height * s); c = o;
  }
  // Color: multiplicadores por canal, gamma, contraste, desenfoque.
  if (t.gain || t.gamma || t.contrast || t.noise) {
    const g = c.getContext('2d'); const im = g.getImageData(0, 0, c.width, c.height); const d = im.data;
    const [kr, kg, kb] = t.gain || [1, 1, 1]; const gm = t.gamma || 1; const ct = t.contrast || 1; const r = rng(3);
    const lut = new Float32Array(256); for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, gm);
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        let v = lut[d[i + k]] * [kr, kg, kb][k]; v = 128 + (v - 128) * ct; if (t.noise) v += (r() - 0.5) * t.noise; d[i + k] = v;
      }
    }
    g.putImageData(im, 0, 0);
  }
  if (t.blur) { const o = mk(c.width, c.height); const g = o.getContext('2d'); g.filter = `blur(${t.blur}px)`; g.drawImage(c, 0, 0); c = o; }
  if (t.glare) {
    const g = c.getContext('2d'); const gr = g.createRadialGradient(c.width * 0.6, c.height * 0.45, 10, c.width * 0.6, c.height * 0.45, c.width * 0.5);
    gr.addColorStop(0, `rgba(255,255,255,${t.glare})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
  }
  return toBlob(c, t.jpeg || 0.9);
}

// --- Captura sintética ---
const COLORS = {
  F: ['#F2E500', '#1F1F1F'], S: ['#8DC47E', '#1F1F1F'], N: ['#3D63B8', '#FFFFFF'], Z: ['#F3B9BF', '#1F1F1F'],
  place: ['#E31CE0', '#5a0a58'], S31: ['#E0281E', '#FFFFFF'], TS: ['#3D63B8', '#FFFFFF'], W: ['#F4B6BF', '#1F1F1F'],
};
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function styleOf(code) {
  if (code === 'TS') return { shape: 'hex', col: COLORS.TS };
  if (code === 'W-') return { shape: 'tag', col: COLORS.W };
  if (code === 'S31') return { shape: 'circle', col: COLORS.S31 };
  if (/^[FSN]\d\d$/.test(code)) return { shape: 'circle', col: COLORS.place };
  return { shape: 'circle', col: COLORS[code[0]] || COLORS.F };
}

// spec: { year, month, first, rows: [[codes]...], width, height, offsetY (desplazamiento de la lista) }
export async function renderScreenshot(spec) {
  const W = spec.width || 1080, H = spec.height || 2400; const c = mk(W, H); const g = c.getContext('2d');
  const u = W / 1080; const font = (px, bold) => `${bold ? '500 ' : ''}${Math.round(px * u)}px Roboto, "Helvetica Neue", Arial, sans-serif`;
  g.fillStyle = '#FAFAFA'; g.fillRect(0, 0, W, H);
  const headH = 330 * u; const rowH = (spec.rowH || 158) * u; const top = headH - (spec.offsetY || 0) * u;
  const days = new Date(Date.UTC(spec.year, spec.month, 0)).getUTCDate();
  const truth = {};
  for (let i = 0; i < spec.rows.length; i++) {
    const day = spec.first + i; if (day > days) break;
    const y = top + i * rowH; if (y > H) break;
    const wd = (new Date(Date.UTC(spec.year, spec.month - 1, day)).getUTCDay() + 6) % 7; const we = wd >= 5;
    g.fillStyle = we ? '#E3E3E3' : '#F7F7F7'; g.fillRect(0, y, W, rowH);
    g.fillStyle = '#C8C8C8'; g.fillRect(0, y + rowH - 2 * u, W, 2 * u);
    g.fillStyle = we ? '#B3261E' : '#222'; g.font = font(52); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(String(day).padStart(2, '0'), 110 * u, y + 66 * u);
    g.fillStyle = we ? '#B3261E' : '#555'; g.font = font(40); g.fillText(WD[wd], 116 * u, y + 128 * u);
    let x = 200 * u; const cy = y + rowH / 2;
    for (const code of spec.rows[i]) {
      if (code === '-') { g.fillStyle = '#D21F1F'; g.fillRect(x + 15 * u, cy - 6 * u, 34 * u, 12 * u); x += 110 * u; continue; }
      if (code === 'U') { g.fillStyle = '#D21F1F'; g.font = font(44, true); g.textAlign = 'center'; g.fillText('U', x + 30 * u, cy + 16 * u); x += 110 * u; continue; }
      const st = styleOf(code); const bw = 112 * u, bh = 102 * u;
      g.fillStyle = st.col[0]; g.beginPath();
      if (st.shape === 'circle') g.ellipse(x + bw / 2, cy, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      else if (st.shape === 'hex') { const r = bh / 2; for (let k = 0; k < 6; k++) { const a = Math.PI / 3 * k; g.lineTo(x + bw / 2 + r * 1.15 * Math.cos(a), cy + r * Math.sin(a)); } }
      else { g.moveTo(x, cy - bh * 0.42); g.lineTo(x + bw * 0.72, cy - bh * 0.42); g.lineTo(x + bw, cy); g.lineTo(x + bw * 0.72, cy + bh * 0.42); g.lineTo(x, cy + bh * 0.42); }
      g.closePath(); g.fill();
      g.fillStyle = st.col[1]; g.font = font(42); g.textAlign = 'center'; g.fillText(code, x + bw * (st.shape === 'tag' ? 0.4 : 0.5), cy + 15 * u);
      x += bw + 14 * u;
    }
    truth[day] = spec.rows[i];
  }
  // Cabecera naranja encima de la lista.
  g.fillStyle = '#F39A1E'; g.fillRect(0, 0, W, headH);
  g.fillStyle = '#2b2b2b'; g.textAlign = 'left'; g.font = font(40); g.fillText('09:41', 60 * u, 60 * u);
  g.font = font(62); g.fillText('Dienstplan', 160 * u, 190 * u);
  g.fillRect(50 * u, 160 * u, 60 * u, 6 * u); g.fillRect(50 * u, 178 * u, 60 * u, 6 * u); g.fillRect(50 * u, 196 * u, 60 * u, 6 * u);
  g.textAlign = 'center'; g.font = font(44); g.fillText(`${MONTHS[spec.month - 1]} ${spec.year}`, W / 2, 290 * u);
  g.font = font(54); g.fillText('‹', 160 * u, 290 * u); g.fillText('›', W - 160 * u, 290 * u);
  // Filas visibles completas → verdad; las cortadas abajo se marcan opcionales (null).
  const required = {}, optional = {};
  for (const [d, codes] of Object.entries(truth)) {
    const i = Number(d) - spec.first; const y = top + i * rowH;
    if (y >= headH - 2 && y + rowH <= H) required[d] = codes; else optional[d] = null;
  }
  return { blob: await toBlob(c, spec.jpeg || 0.92), truth: { month: spec.month, year: spec.year, days: required, optional } };
}

// Negativo: una hoja con una lista numerada (no es el plan) → no debe devolver días.
export async function renderNumberedList(n = 12) {
  const c = mk(1080, 1800); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1080, 1800);
  g.fillStyle = '#222'; g.font = '48px Arial, sans-serif';
  for (let i = 0; i < n; i++) { g.fillText(String(i + 1).padStart(2, '0'), 90, 160 + i * 130); g.fillText(i % 3 ? 'Lorem ipsum' : '', 260, 160 + i * 130); }
  return { blob: await toBlob(c), truth: { month: null, year: null, days: {}, optional: {} } };
}
