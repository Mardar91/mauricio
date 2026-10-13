// Genera capturas de pantalla sintéticas (limpias) de una lista tipo "Dienstplan" con su verdad.
// Uso: node test/lab/approaches/rectify-rows/tools/gen-screens.mjs [n=8] [semilla=7]
// Salida: synth/screens/*.png + manifest.json (con la verdad incluida en cada entrada).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] || 8); let seed = Number(process.argv[3] || 7);
const NOVEL = process.argv.includes('--novel'); // incluye códigos nuevos (F4, S2, F54…)
const FINGER = process.argv.includes('--finger'); // un dedo claro tapa la 2ª insignia de algunas filas
const OUT = path.join(HERE, NOVEL ? 'synth/screens-novel' : FINGER ? 'synth/screens-finger' : 'synth/screens');
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
fs.mkdirSync(OUT, { recursive: true });

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const COL = { F: '#F2E500', S: '#8DC47E', N: '#3D63B8', Z: '#F3B9BF', P: '#E31CE0', R: '#E0281E' };
const shifts = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', ...(NOVEL ? ['F4', 'S2', 'F7', 'N2', 'F4', 'S2'] : [])];
const places = ['F51', 'F52', 'F53', 'S51', 'S52', 'N51', ...(NOVEL ? ['F54', 'S53', 'N52', 'F54'] : [])];

function dayCodes() {
  const r = rnd();
  if (r < 0.25) return ['-'];
  if (r < 0.32) return ['U'];
  if (r < 0.38) return ['W-'];
  if (r < 0.42) return [];
  const s = pick(shifts); const out = [s];
  if (rnd() < 0.12) out.push('TS');
  if (rnd() < 0.6) out.push(rnd() < 0.1 ? 'S31' : pick(places));
  return out;
}

function badge(code, h) {
  const d = Math.round(0.6 * h); const fs = Math.round(0.24 * h);
  const base = `display:inline-flex;align-items:center;justify-content:center;height:${d}px;margin-right:${Math.round(0.08 * h)}px;font:500 ${fs}px sans-serif;`;
  if (code === '-') return `<span style="display:inline-block;width:${Math.round(0.14 * h)}px;height:${Math.round(0.06 * h)}px;background:#D21F1F;margin-left:${Math.round(0.1 * h)}px"></span>`;
  if (code === 'U') return `<span style="font:700 ${Math.round(0.22 * h)}px sans-serif;color:#D21F1F;margin-left:${Math.round(0.1 * h)}px">U</span>`;
  if (code === 'W-') return `<span style="${base}width:${Math.round(1.05 * d)}px;background:#F4B6BF;color:#222;clip-path:polygon(0 0,70% 0,100% 50%,70% 100%,0 100%)">W-</span>`;
  if (code === 'TS') return `<span style="${base}width:${Math.round(1.15 * d)}px;background:${COL.N};color:#fff;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)">TS</span>`;
  const bg = code === 'S31' ? COL.R : code.length === 3 ? COL.P : COL[code[0]];
  const fg = code === 'N1' || code === 'S31' ? '#fff' : code.length === 3 ? '#5a0a5a' : '#222';
  return `<span style="${base}width:${Math.round(1.08 * d)}px;border-radius:50%;background:${bg};color:${fg}">${code}</span>`;
}

function page(year, month, startDay, scroll, W, Hs, rowH) {
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows = []; const gt = {};
  for (let d = 1; d <= dim; d++) {
    const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay(); const we = wd === 0 || wd === 6;
    const codes = dayCodes(); gt[d] = codes;
    rows.push(`<div class="row${we ? ' we' : ''}"><div class="num"><b>${String(d).padStart(2, '0')}</b><i>${WD[wd]}</i></div><div class="bd">${codes.map((c) => badge(c, rowH)).join('')}</div></div>`);
  }
  const hdrH = Math.round(2.3 * rowH);
  // dedo: elipse color piel con sombreado sobre la 2ª insignia de dos filas visibles con 2 insignias
  let fingerHtml = ''; const covered = [];
  if (FINGER) {
    const vis = [];
    for (let d = 1; d <= dim; d++) { const y0 = hdrH - scroll + (d - startDay) * rowH; if (y0 > hdrH + rowH && y0 < Hs - 3 * rowH && gt[d].length >= 2) vis.push(d); }
    for (const d of vis.filter((_, i) => i % 2 === 0).slice(0, 2)) {
      const y0 = hdrH - scroll + (d - startDay) * rowH; const x = Math.round(0.95 * rowH + 0.1 * rowH + 0.75 * rowH);
      // dedo que entra desde el borde derecho: punta redondeada sobre la 2ª insignia
      fingerHtml += `<div style="position:absolute;z-index:3;left:${x}px;top:${y0 + Math.round(0.05 * rowH)}px;width:${W - x + 80}px;height:${Math.round(0.9 * rowH)}px;border-radius:${Math.round(0.45 * rowH)}px 0 0 ${Math.round(0.45 * rowH)}px;background:linear-gradient(180deg,#e9b99c,#f2c9b0 40%,#d9a080 85%,#c48a6a);transform:rotate(-6deg);transform-origin:left center"></div>`;
      covered.push(d);
    }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;width:${W}px;height:${Hs}px;overflow:hidden;background:#fafafa;font-family:sans-serif}
    .hdr{position:absolute;top:0;left:0;right:0;height:${hdrH}px;background:#F39A1E;z-index:2;color:#3a2a10}
    .st{height:${Math.round(0.45 * rowH)}px;font:${Math.round(0.2 * rowH)}px sans-serif;padding:${Math.round(0.12 * rowH)}px ${Math.round(0.4 * rowH)}px}
    .ti{font:${Math.round(0.3 * rowH)}px sans-serif;padding:${Math.round(0.15 * rowH)}px ${Math.round(0.3 * rowH)}px}
    .mo{display:flex;justify-content:space-between;font:${Math.round(0.22 * rowH)}px sans-serif;padding:${Math.round(0.12 * rowH)}px ${Math.round(0.9 * rowH)}px}
    .list{position:absolute;top:${hdrH - scroll}px;left:0;right:0}
    .row{height:${rowH - 1}px;border-bottom:1px solid #c8c8c8;display:flex;align-items:center;background:#f7f7f7}
    .row.we{background:#dedede}
    .num{width:${Math.round(0.95 * rowH)}px;text-align:center;line-height:1.15}
    .num b{display:block;font:400 ${Math.round(0.3 * rowH)}px sans-serif;color:#222}
    .num i{display:block;font:normal ${Math.round(0.2 * rowH)}px sans-serif;color:#666}
    .we .num b,.we .num i{color:#B71C1C}
    .bd{display:flex;align-items:center;padding-left:${Math.round(0.1 * rowH)}px}
    .nav{position:absolute;bottom:0;left:0;right:0;height:${Math.round(0.7 * rowH)}px;background:rgba(250,250,250,0.85);z-index:2;display:flex;justify-content:space-around;align-items:center;font:${Math.round(0.3 * rowH)}px sans-serif;color:#444}
  </style></head><body>
  <div class="hdr"><div class="st">10:43 <span style="float:right">▾ ◢ 98</span></div><div class="ti">☰ &nbsp;Dienstplan <span style="float:right">⋮</span></div>
  <div class="mo"><span>‹</span><span>${MONTHS[month - 1]} ${year}</span><span>›</span></div></div>
  <div class="list" style="transform:translateY(${-(startDay - 1) * rowH}px)">${rows.join('')}</div>
  <div class="nav"><span>|||</span><span>◯</span><span>‹</span></div>${fingerHtml}</body></html>`;
  // verdad: filas enteras visibles entre la cabecera y la barra de navegación
  const days = {}; const optional = {};
  const top = hdrH, bot = Hs - Math.round(0.7 * rowH);
  for (let d = 1; d <= dim; d++) {
    const y0 = hdrH - scroll + (d - startDay) * rowH, y1 = y0 + rowH;
    if (y1 <= top || y0 >= Hs) continue;
    if (covered.includes(d)) optional[d] = gt[d]; // tapada: si se devuelve, debe ser correcta
    else if (y0 >= top - 1 && y1 <= bot + 1) days[d] = gt[d]; else optional[d] = null;
  }
  return { html, days, optional };
}

const browser = await chromium.launch();
const manifest = [];
for (let n = 0; n < N; n++) {
  const year = 2026 + (rnd() < 0.3 ? 1 : 0), month = 1 + Math.floor(rnd() * 12);
  const W = pick([1080, 1170, 720]); const Hs = Math.round(W * pick([2.0, 2.165, 1.78]));
  const rowH = Math.round(W / pick([6.5, 7, 7.5]));
  const startDay = 1 + Math.floor(rnd() * 18); const scroll = Math.round(rnd() * 0.6 * rowH);
  const { html, days, optional } = page(year, month, startDay, scroll, W, Hs, rowH);
  const pg = await browser.newPage({ viewport: { width: W, height: Hs } });
  await pg.setContent(html);
  const file = `screen-${n}.png`;
  await pg.screenshot({ path: path.join(OUT, file) });
  await pg.close();
  manifest.push({ file, variant: 'screen', gt: { month, year, days, optional } });
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(manifest.length, 'capturas en', OUT);
