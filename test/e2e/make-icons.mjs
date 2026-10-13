// Genera los iconos de la app (SVG + PNG) dibujando el SVG con Chromium.
// Uso: node test/e2e/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs/icons');

// Calendario blanco con la lista de turnos (insignias amarilla, verde y azul) sobre fondo naranja.
// rounded: esquinas redondeadas (favicon / Android); scale: tamaño del dibujo (maskable = más pequeño).
export function iconSvg({ rounded = true, scale = 1 } = {}) {
  const bg = rounded ? '<rect width="512" height="512" rx="114" fill="url(#bg)"/>' : '<rect width="512" height="512" fill="url(#bg)"/>';
  const t = `translate(256 262) scale(${scale}) translate(-256 -262)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFB24A"/>
      <stop offset="0.55" stop-color="#F28A15"/>
      <stop offset="1" stop-color="#E26A00"/>
    </linearGradient>
    <linearGradient id="head" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFE3C2"/>
      <stop offset="1" stop-color="#FFD3A1"/>
    </linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#7A3300" flood-opacity="0.32"/>
    </filter>
  </defs>
  ${bg}
  <g transform="${t}">
    <g filter="url(#sh)">
      <rect x="100" y="112" width="312" height="318" rx="48" fill="#FFFFFF"/>
    </g>
    <path d="M100 160a48 48 0 0 1 48-48h216a48 48 0 0 1 48 48v28H100z" fill="url(#head)"/>
    <rect x="168" y="80" width="30" height="74" rx="15" fill="#FFFFFF" stroke="#E98A1E" stroke-width="10"/>
    <rect x="314" y="80" width="30" height="74" rx="15" fill="#FFFFFF" stroke="#E98A1E" stroke-width="10"/>
    <g>
      <rect x="138" y="223" width="40" height="18" rx="9" fill="#E4DCD2"/>
      <ellipse cx="236" cy="232" rx="40" ry="26" fill="#F2E500"/>
      <rect x="296" y="225" width="80" height="14" rx="7" fill="#EFE9E2"/>
      <rect x="138" y="297" width="40" height="18" rx="9" fill="#E4DCD2"/>
      <ellipse cx="236" cy="306" rx="40" ry="26" fill="#8DC47E"/>
      <rect x="296" y="299" width="62" height="14" rx="7" fill="#EFE9E2"/>
      <rect x="138" y="371" width="40" height="18" rx="9" fill="#E4DCD2"/>
      <ellipse cx="236" cy="380" rx="40" ry="26" fill="#3D63B8"/>
      <rect x="296" y="373" width="72" height="14" rx="7" fill="#EFE9E2"/>
    </g>
  </g>
</svg>
`;
}

async function render(page, svg, size, file, { transparent = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`);
  await page.screenshot({ path: path.join(OUT, file), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.svg'), iconSvg({ rounded: true }));
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await render(page, iconSvg({ rounded: true }), 192, 'icon-192.png', { transparent: true });
  await render(page, iconSvg({ rounded: true }), 512, 'icon-512.png', { transparent: true });
  await render(page, iconSvg({ rounded: false, scale: 0.78 }), 512, 'maskable-512.png');
  await render(page, iconSvg({ rounded: false, scale: 0.94 }), 180, 'apple-touch-icon.png');
  await browser.close();
  console.log('Iconos generados en docs/icons/');
}
