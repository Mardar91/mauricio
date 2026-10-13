// Distorsiones de "foto de un monitor" para las capturas sintéticas (se ejecuta en el navegador).
import { homography, inv, apply } from '../geom.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

async function loadImg(url) { const im = new Image(); im.src = url; await im.decode(); return im; }

// p: parámetros (ver generate.mjs). Devuelve { jpeg, W, H, status: {día: 'ok'|'partial'|'out'|'occluded'}, titleOk }
export async function distort(pngUrl, p, cellRects, titleRect) {
  const R = rng(p.seed);
  const img = await loadImg(pngUrl);
  const Ws0 = img.width; const Hs0 = img.height;
  // reducción previa con suavizado (como la óptica de la cámara) para no "romper" las líneas finas
  const pre = Math.min(1, p.zoom * 1.15);
  const Ws = Math.round(Ws0 * pre); const Hs = Math.round(Hs0 * pre);
  const sc = document.createElement('canvas'); sc.width = Ws; sc.height = Hs; const sg = sc.getContext('2d');
  sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high'; sg.drawImage(img, 0, 0, Ws, Hs);
  const sd = sg.getImageData(0, 0, Ws, Hs).data;
  const W = p.W; const H = p.H;
  // esquinas de la pantalla en la foto: escala + giro + perspectiva
  const cx = W / 2 + p.offX * W; const cy = H / 2 + p.offY * H;
  const k = p.zoom; const th = (p.rot * Math.PI) / 180;
  const corners = [[0, 0], [Ws0, 0], [Ws0, Hs0], [0, Hs0]].map(([x, y], i) => {
    let dx = (x - p.focusX) * k; let dy = (y - p.focusY) * k;
    // trapecio (perspectiva): lado izquierdo/derecho, superior/inferior
    const fx = x / Ws0 - 0.5; const fy = y / Hs0 - 0.5;
    dx *= 1 + p.keyY * fy * 2; dy *= 1 + p.keyX * fx * 2;
    dx += p.jit[i][0] * W; dy += p.jit[i][1] * H;
    return [cx + dx * Math.cos(th) - dy * Math.sin(th), cy + dx * Math.sin(th) + dy * Math.cos(th)];
  });
  // Hsp: pantalla original → foto; Hps: foto → pantalla reducida
  const Hsp = homography([[0, 0], [Ws0, 0], [Ws0, Hs0], [0, Hs0]], corners);
  const Hps = inv(homography([[0, 0], [Ws, 0], [Ws, Hs], [0, Hs]], corners));
  const out = document.createElement('canvas'); out.width = W; out.height = H; const og = out.getContext('2d');
  const id = og.createImageData(W, H); const o = id.data;
  const bez = p.bezel; const mo = p.moire; const li = p.light;
  const cosA = Math.cos(mo.ang); const sinA = Math.sin(mo.ang); const cosB = Math.cos(mo.ang2); const sinB = Math.sin(mo.ang2);
  const lx = Math.cos(li.dir); const ly = Math.sin(li.dir);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const den = Hps[6] * x + Hps[7] * y + Hps[8];
      const sx = (Hps[0] * x + Hps[1] * y + Hps[2]) / den; const sy = (Hps[3] * x + Hps[4] * y + Hps[5]) / den;
      const oi = (y * W + x) * 4;
      let r; let g; let b;
      if (sx >= 0 && sy >= 0 && sx < Ws - 1 && sy < Hs - 1) {
        const x0 = sx | 0; const y0 = sy | 0; const fx = sx - x0; const fy = sy - y0;
        const i00 = (y0 * Ws + x0) * 4; const i10 = i00 + 4; const i01 = i00 + Ws * 4; const i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy); const w10 = fx * (1 - fy); const w01 = (1 - fx) * fy; const w11 = fx * fy;
        r = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        g = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        b = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        // moiré de la rejilla de píxeles (fases distintas por canal → franjas de color)
        if (mo.amp > 0) {
          const t1 = (2 * Math.PI * (x * cosA + y * sinA)) / mo.per; const t2 = (2 * Math.PI * (x * cosB + y * sinB)) / mo.per2;
          const base = 1 - mo.amp * (0.5 + 0.5 * Math.sin(t1) * Math.sin(t2));
          r *= base - mo.chroma * Math.sin(t1 + 2.1); g *= base - mo.chroma * Math.sin(t1); b *= base - mo.chroma * Math.sin(t1 - 2.1);
        }
      } else {
        const v = bez.v + (R() - 0.5) * 6; r = v; g = v; b = v * 1.05;
      }
      // iluminación: degradado + tinte
      const f = li.b0 + (li.b1 - li.b0) * (0.5 + 0.5 * (((x / W - 0.5) * lx + (y / H - 0.5) * ly) * 2));
      r *= f * li.tint[0]; g *= f * li.tint[1]; b *= f * li.tint[2];
      // reflejo
      for (const gl of p.glare) {
        const dx = (x - gl.x * W) / (gl.rx * W); const dy = (y - gl.y * H) / (gl.ry * H);
        const e = Math.exp(-(dx * dx + dy * dy) * 2) * gl.a * 255; r += e; g += e; b += e;
      }
      o[oi] = r; o[oi + 1] = g; o[oi + 2] = b; o[oi + 3] = 255;
    }
  }
  og.putImageData(id, 0, 0);
  // dedo (oclusión)
  let finger = null;
  if (p.finger) {
    finger = p.finger;
    og.save(); og.translate(finger.x * W, finger.y * H); og.rotate(finger.ang);
    const grd = og.createLinearGradient(-finger.rx * W, 0, finger.rx * W, 0);
    grd.addColorStop(0, '#b77a5d'); grd.addColorStop(0.5, '#e1a888'); grd.addColorStop(1, '#a86b50');
    og.fillStyle = grd; og.beginPath(); og.ellipse(0, 0, finger.rx * W, finger.ry * H * 3, 0, 0, Math.PI * 2); og.fill(); og.restore();
  }
  // desenfoque + ruido
  let fin = out;
  if (p.blur > 0.05) {
    fin = document.createElement('canvas'); fin.width = W; fin.height = H; const fg = fin.getContext('2d');
    fg.filter = `blur(${p.blur}px)`; fg.drawImage(out, 0, 0);
  }
  if (p.noise > 0) {
    const fg = fin.getContext('2d'); const d = fg.getImageData(0, 0, W, H); const a = d.data;
    for (let i = 0; i < a.length; i += 4) { const n = (R() + R() + R() - 1.5) * p.noise * 2; a[i] += n; a[i + 1] += n + (R() - 0.5) * p.noise; a[i + 2] += n + (R() - 0.5) * p.noise; }
    fg.putImageData(d, 0, 0);
  }
  const jpeg = fin.toDataURL('image/jpeg', p.quality);
  // estado de cada día: visible, cortado, fuera o tapado
  const inFinger = (x, y) => {
    if (!finger) return false;
    const dx = x - finger.x * W; const dy = y - finger.y * H; const c = Math.cos(-finger.ang); const s = Math.sin(-finger.ang);
    const u = dx * c - dy * s; const v = dx * s + dy * c;
    return (u / (finger.rx * W)) ** 2 + (v / (finger.ry * H * 3)) ** 2 <= 1.15;
  };
  const status = {};
  for (const [d, q] of Object.entries(cellRects)) {
    let inside = 0; let occ = 0; let n = 0;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 6; j++) {
      const [x, y] = apply(Hsp, q.x0 + ((q.x1 - q.x0) * i) / 4, q.y0 + ((q.y1 - q.y0) * j) / 6); n++;
      if (x >= 2 && y >= 2 && x <= W - 3 && y <= H - 3) inside++;
      if (inFinger(x, y)) occ++;
    }
    status[d] = occ ? 'occluded' : inside === n ? 'ok' : inside === 0 ? 'out' : 'partial';
  }
  let titleOk = true;
  if (titleRect) for (const [x, y] of [[titleRect.x0, titleRect.y0], [titleRect.x1, titleRect.y1]]) { const [a, b2] = apply(Hsp, x, y); if (a < 0 || b2 < 0 || a > W || b2 > H) titleOk = false; }
  return { jpeg, W, H, status, titleOk };
}
