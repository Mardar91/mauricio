// Utilidades compartidas por los tests e2e y las capturas de pantalla.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Europe/Berlin';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OUT = path.join(ROOT, 'test/e2e/out');
export const STORAGE_KEY = 'turnos-mauricio:v1';

export const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// "Ahora" fijo para capturas y tests: martes 13 de octubre de 2026, 10:15 en Berlín
export const NOW = new Date('2026-10-13T10:15:00+02:00');

const core = await import(path.join(ROOT, 'docs/js/core/index.js'));
export { core };

// Días de ground-truth.json (junio–octubre 2026) → { 'YYYY-MM-DD': codes[] }
export function groundTruthDays() {
  const gt = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/lab/ground-truth.json'), 'utf8'));
  const days = {};
  for (const p of gt.photos) {
    const all = { ...Object.fromEntries(Object.entries(p.optional || {}).filter(([, v]) => Array.isArray(v))), ...p.days };
    for (const [d, codes] of Object.entries(all)) days[core.makeKey(p.year, p.month, Number(d))] = codes;
  }
  return days;
}

// Estado de demostración realista (datos de las fotos + algunos extras)
export function demoState({ sync = false, ntfy = false } = {}) {
  let s = core.createDefaultState();
  s = core.updateSettings(s, { onboardingDone: true });
  const at = new Date('2026-10-02T18:30:00+02:00');
  const days = groundTruthDays();
  // Hueco 1–8 de octubre (no sale en las fotos): turnos plausibles
  const extra = {
    '2026-10-01': ['F1', 'F51'], '2026-10-02': ['F1', 'F51'], '2026-10-03': ['-'], '2026-10-04': ['-'],
    '2026-10-05': ['S1', 'S52'], '2026-10-06': ['S1', 'S52'], '2026-10-07': ['Z1', 'S52'], '2026-10-08': ['-'],
  };
  for (const [k, v] of Object.entries({ ...extra, ...days }).sort()) {
    s = core.setDay(s, k, v, { source: k in extra ? 'manual' : 'scan', now: at });
  }
  s = core.setDay(s, '2026-10-15', s.days['2026-10-15'].codes, { note: 'Llevar las llaves del coche', now: at });
  s = core.setDay(s, '2026-10-13', ['Z1', 'S51'], { source: 'scan', now: new Date('2026-10-01T09:00:00+02:00') });
  s = core.setDay(s, '2026-10-13', ['S1', 'S51'], { source: 'manual', now: new Date('2026-10-12T19:40:00+02:00') });
  s.scans = [
    { at: '2026-10-11T09:35:00.000Z', layout: 'phone-list', month: 10, year: 2026, daysFound: 11 },
    { at: '2026-10-12T04:57:00.000Z', layout: 'phone-list', month: 10, year: 2026, daysFound: 10 },
  ];
  if (sync) {
    s = core.updateSettings(s, { sync: { enabled: true, token: 'github_pat_demo', lastPushAt: '2026-10-13T07:58:00.000Z', lastPushHash: 'x' } });
  }
  if (ntfy) {
    s = core.updateSettings(s, { ntfy: { enabled: true, topic: 'turnos-mauricio-k3v9q2m7x1pd', scheduled: { '2026-10-13-S1-pre': { at: '2026-10-13T10:30:00.000Z', hash: 'h' } } } });
  }
  return s;
}

// Contexto tipo iPhone (390×844) en Chromium
export async function iphoneContext(browser, { theme = 'light', width = 390, height = 844, scale = 3, ios = true, sw = 'block' } = {}) {
  return browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    isMobile: true,
    hasTouch: true,
    userAgent: ios ? IPHONE_UA : undefined,
    colorScheme: theme,
    locale: 'es-ES',
    timezoneId: 'Europe/Berlin',
    serviceWorkers: sw,
    acceptDownloads: true,
  });
}

// Prepara una página: hora fija, estado inicial en localStorage y registro de errores
export async function preparePage(context, { state = null, now = NOW, errors = [] } = {}) {
  const page = await context.newPage();
  if (now) await page.clock.setFixedTime(now);
  if (state) {
    await page.addInitScript(([key, json]) => {
      if (!sessionStorage.getItem('__seeded')) {
        localStorage.setItem(key, json);
        sessionStorage.setItem('__seeded', '1');
      }
    }, [STORAGE_KEY, JSON.stringify(state)]);
  }
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 404 esperado de GitHub (archivo aún no creado): el navegador lo anota siempre
    if (/Failed to load resource/.test(m.text()) && /api\.github\.com\/.*\/contents\//.test(m.location()?.url || '')) return;
    errors.push(`console: ${m.text()} ${m.location()?.url || ''}`.trim());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return page;
}

// Elementos que se salen por los lados (sin contar los que están dentro de zonas con scroll propio)
export async function findOverflow(page) {
  return page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const out = [];
    if (document.documentElement.scrollWidth > W + 1) out.push(`documento: scrollWidth ${document.documentElement.scrollWidth} > ${W}`);
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.photo-strip, .tabbar, svg, .visually-hidden, [hidden]')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.right > W + 1 || r.left < -1) {
        const name = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
        out.push(`${name} [${Math.round(r.left)}, ${Math.round(r.right)}] "${(el.textContent || '').trim().slice(0, 30)}"`);
      }
      // Texto cortado sin puntos suspensivos
      if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 1 && cs.overflow === 'hidden' && cs.textOverflow !== 'ellipsis') {
        out.push(`recortado: ${el.tagName.toLowerCase()}.${el.className} "${el.textContent.trim().slice(0, 30)}"`);
      }
    }
    return [...new Set(out)].slice(0, 30);
  });
}

export function ensureOut() {
  fs.mkdirSync(OUT, { recursive: true });
  return OUT;
}

// Simula la API de GitHub y ntfy.sh (nada sale a internet en los tests). Devuelve el registro de llamadas.
export async function mockNetwork(page, { githubStatus = 200 } = {}) {
  const log = { github: [], ntfy: [], files: {} };
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    log.github.push(`${method} ${url.pathname}`);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE' } });
    if (githubStatus !== 200) return json(githubStatus, { message: 'Bad credentials' });
    const m = /^\/repos\/[^/]+\/[^/]+(\/.*)?$/.exec(url.pathname);
    const rest = m?.[1] || '';
    if (!rest) return json(200, { private: false, default_branch: 'main', permissions: { push: true } });
    if (rest.startsWith('/git/ref/heads/')) return json(200, { object: { sha: 'abc123' } });
    if (rest === '/git/refs') return json(201, { ref: 'refs/heads/datos' });
    const file = rest.replace(/^\/contents\//, '');
    if (method === 'GET') {
      const f = log.files[file];
      return f ? json(200, { sha: 'sha-' + file, encoding: 'base64', content: Buffer.from(f, 'utf8').toString('base64') }) : json(404, { message: 'Not Found' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(req.postData() || '{}');
      log.files[file] = Buffer.from(body.content || '', 'base64').toString('utf8');
      return json(201, { content: { sha: 'sha-' + file } });
    }
    return json(404, { message: 'Not Found' });
  });
  await page.route('https://ntfy.sh/**', async (route) => {
    const req = route.request();
    log.ntfy.push(`${req.method()} ${new URL(req.url()).pathname} ${req.postData() || ''}`.trim());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  return log;
}
