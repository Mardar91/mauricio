// Genera capturas sintéticas "limpias" parecidas a la app Dienstplan (solo desarrollo).
// Uso: node test/lab/approaches/color-first/tools/gen-screens.mjs [n=24]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 24);
const MODE = process.argv[3] || 'mix'; // mix | free (solo guiones, U y vacíos)
const NAME = MODE === 'mix' ? 'screens' : 'screens-' + MODE;
const OUT = path.join(HERE, '..', 'synth', NAME);
fs.mkdirSync(OUT, { recursive: true });

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const COL = {
  F: ['#F2E500', '#222'], S: ['#8DC47E', '#222'], N: ['#3D63B8', '#fff'], Z: ['#F3B9BF', '#333'],
  P: ['#E31CE0', 'rgba(70,0,70,0.75)'], S31: ['#E0281E', '#fff'],
};
function badge(code) {
  if (code === '-') return '<span class="dash"></span>';
  if (code === 'U') return '<span class="u">U</span>';
  if (code === 'W-') return '<span class="tag">W-</span>';
  if (code === 'TS') return '<span class="hex">TS</span>';
  let c;
  if (/^[FSNZ]\d\d$/.test(code)) c = code === 'S31' ? COL.S31 : COL.P;
  else c = COL[code[0]];
  return `<span class="b" style="background:${c[0]};color:${c[1]}">${code}</span>`;
}
const SHIFT = ['F1', 'F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'S1', 'N1', 'Z1', 'F4', 'S2'];
const PLACE = { F: ['F51', 'F52', 'F53', 'F54'], S: ['S51', 'S52'], N: ['N51'], Z: ['F53', 'S52'] };
function dayCodes() {
  const r = rnd();
  if (MODE === 'free') return r < 0.6 ? ['-'] : r < 0.9 ? ['U'] : [];
  if (r < 0.25) return ['-'];
  if (r < 0.32) return ['U'];
  if (r < 0.38) return ['W-'];
  if (r < 0.42) return [];
  const s = pick(SHIFT);
  if (rnd() < 0.08) return [s, 'TS'];
  if (rnd() < 0.05) return [s, 'S31'];
  if (rnd() < 0.6) return [s, pick(PLACE[s[0]])];
  return [s];
}

const css = `
body{margin:0;font-family:Roboto,"Noto Sans",Arial,sans-serif;background:#fff;width:412px;height:915px;overflow:hidden}
.top{background:#F2A12E;height:150px;color:#2b1d0e;position:relative}
.sb{height:34px;font-size:14px;padding:8px 22px 0;display:flex;justify-content:space-between}
.ab{height:56px;display:flex;align-items:center;padding:0 18px;font-size:22px}
.ab .m{margin-right:20px;font-size:22px}
.ml{display:flex;justify-content:space-between;align-items:center;padding:0 40px;font-size:17px;height:50px}
.row{height:58px;border-bottom:1px solid #d6d6d6;display:flex;align-items:center;background:#fafafa;position:relative}
.row.we{background:#e6e6e6}
.dn{width:62px;text-align:center;line-height:1}
.dn .n{font-size:23px;color:#222;display:block}
.dn .w{font-size:16px;color:#444;display:block;margin-top:5px}
.we .dn .n,.we .dn .w{color:#b3263a}
.b{display:inline-flex;width:40px;height:37px;border-radius:50%;align-items:center;justify-content:center;font-size:15px;margin-right:5px}
.dash{display:inline-block;width:10px;height:4px;background:#D21F1F;margin:0 15px}
.u{display:inline-block;width:40px;text-align:center;color:#D21F1F;font-weight:bold;font-size:16px}
.tag{display:inline-flex;align-items:center;padding-left:8px;width:36px;height:34px;background:#F4B6BF;color:#333;font-size:15px;clip-path:polygon(0 0,72% 0,100% 50%,72% 100%,0 100%);margin-right:5px}
.hex{display:inline-flex;align-items:center;justify-content:center;width:44px;height:37px;background:#3D63B8;color:#fff;font-size:15px;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);margin-right:5px}
.codes{display:flex;align-items:center;padding-left:8px}
.nav{position:absolute;bottom:0;left:0;right:0;height:48px;background:rgba(255,255,255,0.85);display:flex;justify-content:space-around;align-items:center;font-size:22px;color:#555}
`;

const browser = await chromium.launch();
const photos = [];
for (let i = 0; i < N; i++) {
  const year = pick([2025, 2026, 2027]); const month = 1 + Math.floor(rnd() * 12);
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const scrollPx = Math.floor(rnd() * Math.max(1, (dim - 11) * 58 + 30));
  const first = Math.floor(scrollPx / 58) + 1;
  const offset = scrollPx % 58;
  const listTop = 150, listH = 915 - 150;
  let rows = ''; const days = {}, optional = {};
  for (let d = first; d <= dim && (d - first) * 58 - offset < listH; d++) {
    const wd = (new Date(Date.UTC(year, month - 1, d)).getUTCDay() + 6) % 7;
    const codes = dayCodes();
    rows += `<div class="row${wd >= 5 ? ' we' : ''}"><div class="dn"><span class="n">${String(d).padStart(2, '0')}</span><span class="w">${WD[wd]}</span></div><div class="codes">${codes.map(badge).join('')}</div></div>`;
    const y0 = listTop + (d - first) * 58 - offset, y1 = y0 + 58;
    if (y0 >= listTop - 1 && y1 <= 915 - 48) days[d] = codes; else optional[d] = null;
  }
  const html = `<!doctype html><html><head><style>${css}</style></head><body>
<div class="top"><div class="sb"><span>${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}</span><span>▾ ▴ 88</span></div>
<div class="ab"><span class="m">☰</span>Dienstplan<span style="margin-left:auto">⋮</span></div>
<div class="ml"><span>‹</span><span>${MONTHS[month - 1]} ${year}</span><span>›</span></div></div>
<div style="position:absolute;top:150px;left:0;right:0;bottom:0;overflow:hidden"><div style="margin-top:${-offset}px">${rows}</div></div>
<div class="nav"><span>|||</span><span>▢</span><span>‹</span></div></body></html>`;
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625 });
  await page.setContent(html);
  const fname = `screen-${String(i).padStart(2, '0')}-${year}-${String(month).padStart(2, '0')}.png`;
  await page.screenshot({ path: path.join(OUT, fname) });
  await page.close();
  photos.push({ file: `test/lab/approaches/color-first/synth/${NAME}/` + fname, layout: 'phone-list', month, year, days, optional, variant: 'screen' });
}
await browser.close();
fs.writeFileSync(path.join(HERE, '..', 'synth', NAME + '.json'), JSON.stringify({ photos }, null, 1));
console.log(photos.length, 'capturas');
