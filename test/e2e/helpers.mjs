// Utilidades compartidas por los tests e2e y las capturas de pantalla.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Europe/Berlin';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OUT = path.join(ROOT, 'test/e2e/out');
export const STORAGE_KEY = 'turnos-mauricio:v1';

export const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Android (Chrome en un Samsung Galaxy A54) y un ordenador (Chrome en Windows)
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
// iPad (Safari se presenta como Mac, con pantalla táctil)
export const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

// "Ahora" fijo para capturas y tests: martes 13 de octubre de 2026, 10:15 en Berlín
export const NOW = new Date('2026-10-13T10:15:00+02:00');

const core = await import(path.join(ROOT, 'docs/js/core/index.js'));
export { core };

// Token y clave con el formato real (github_pat_ + 82 caracteres; clave base64url de 43)
export const TOKEN = `github_pat_${'A'.repeat(22)}_${'B'.repeat(59)}`;
export const KEY = Buffer.alloc(32, 7).toString('base64url');
export const OTHER_KEY = Buffer.alloc(32, 9).toString('base64url');
export const OWNER = 'Mardar91';
export const REPO = 'mauricio-datos';
// Configuración de sync de este teléfono (para estados de prueba ya conectados)
export const SYNC = { enabled: true, owner: OWNER, repo: REPO, branch: '', token: TOKEN, key: KEY };

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
    s = core.updateSettings(s, { sync: {
      ...SYNC, deviceId: 'iphone1', publisher: 'iphone1', publisherSince: '2026-10-01T08:00:00.000Z',
      lastPushAt: '2026-10-13T07:58:00.000Z', lastPullAt: '2026-10-13T08:10:00.000Z', lastPushHash: 'x', baseRev: 3,
    } });
  }
  if (ntfy) {
    s = core.updateSettings(s, { ntfy: { enabled: true, topic: 'turnos-mauricio-k3v9q2m7x1pd', scheduled: { '2026-10-13-S1-pre': { at: '2026-10-13T10:30:00.000Z', hash: 'h' } } } });
  }
  return s;
}

// Contexto tipo iPhone (390×844) en Chromium. device: 'iphone' (por defecto) | 'android' | 'ipad' | 'desktop'
export async function iphoneContext(browser, { theme = 'light', width = 390, height = 844, scale = 3, ios = true, device, sw = 'block' } = {}) {
  const dev = device || (ios ? 'iphone' : 'other');
  const desktop = dev === 'desktop';
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: desktop ? 1 : scale,
    isMobile: !desktop && dev !== 'ipad',
    hasTouch: !desktop,
    userAgent: { iphone: IPHONE_UA, android: ANDROID_UA, desktop: DESKTOP_UA, ipad: IPAD_UA }[dev],
    colorScheme: theme,
    locale: 'es-ES',
    timezoneId: 'Europe/Berlin',
    serviceWorkers: sw,
    acceptDownloads: true,
  });
  // Un iPad de verdad: Safari se presenta como Mac, pero con pantalla táctil (maxTouchPoints 5)
  if (dev === 'ipad') {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });
    });
  }
  return context;
}

// Prepara una página: hora fija, estado inicial en localStorage y registro de errores.
// standalone: true simula la app abierta desde la pantalla de inicio (navigator.standalone)
export async function preparePage(context, { state = null, now = NOW, errors = [], standalone = false } = {}) {
  const page = await context.newPage();
  if (now) await page.clock.setFixedTime(now);
  if (standalone) {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true });
    });
  }
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
    // 404/409 esperados de GitHub (archivo o rama aún no creados): el navegador los anota siempre
    if (/Failed to load resource/.test(m.text()) && /api\.github\.com\//.test(m.location()?.url || '')) return;
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

// GitHub simulado en memoria (como test/unit/helpers.mjs → fakeGitHub, pero para cualquier owner/repo):
// commits con instantáneas, ramas, repo vacío (409 en git/ref), PUT que exige el sha y devuelve
// content.sha y commit.sha. gh.fetch sirve para usar el core desde Node (p. ej. sembrar la copia de otro
// dispositivo); la página usa el mismo estado a través de page.route (mockNetwork).
export function fakeGitHub({ empty = false, defaultBranch = 'main', status = 200, hasPages = false } = {}) {
  const gh = { commits: {}, branches: {}, seq: 0, defaultBranch, status, log: [] };
  if (!empty) {
    gh.commits.c0 = { 'README.md': { sha: 'f0', text: '# datos' } };
    gh.branches[defaultBranch] = 'c0';
  }
  const filesOf = (branch) => gh.commits[gh.branches[branch]] || null;
  gh.file = (p, branch = defaultBranch) => filesOf(branch)?.[p] ?? null;
  gh.text = (p, branch) => gh.file(p, branch)?.text ?? null;
  gh.json = (p, branch) => { const t = gh.text(p, branch); return t ? JSON.parse(t) : null; };
  gh.write = (p, text, branch = defaultBranch) => {
    const commit = `c${++gh.seq}`;
    gh.commits[commit] = { ...(filesOf(branch) || {}), [p]: { sha: `f${gh.seq}`, text } };
    gh.branches[branch] = commit;
    return commit;
  };
  gh.remove = (p, branch = defaultBranch) => {
    const files = { ...(filesOf(branch) || {}) };
    delete files[p];
    gh.commits[`c${++gh.seq}`] = files;
    gh.branches[branch] = `c${gh.seq}`;
  };
  // Listado de una carpeta (API contents): [{ type: 'file'|'dir', name, path, sha }]
  gh.listing = (dir, branch = defaultBranch) => {
    const files = filesOf(branch) || {};
    const prefix = dir ? `${dir}/` : '';
    const entries = new Map();
    for (const [p, f] of Object.entries(files)) {
      if (!p.startsWith(prefix)) continue;
      const [first, ...more] = p.slice(prefix.length).split('/');
      if (!entries.has(first)) entries.set(first, { name: first, path: prefix + first, type: more.length ? 'dir' : 'file', sha: more.length ? `d-${first}` : f.sha });
    }
    return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  };
  // Escrituras recibidas (PUT/POST), por archivo
  gh.writes = (p) => gh.log.filter((l) => /^(PUT|POST) /.test(l) && (!p || l.endsWith(`/${p}`)));

  // { method, url, body } → { status, body }
  gh.handle = ({ method, url, body }) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    gh.log.push(`${method} ${p}${u.search}`);
    if (gh.status !== 200) return { status: gh.status, body: { message: gh.status === 401 ? 'Bad credentials' : 'Error' } };
    const m0 = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m0) return { status: 404, body: { message: 'Not Found' } };
    const rest = m0[3] || '';
    const isEmpty = !Object.keys(gh.branches).length;
    let m;
    if (!rest && method === 'GET') {
      return { status: 200, body: { full_name: `${m0[1]}/${m0[2]}`, default_branch: defaultBranch, private: false, has_pages: hasPages, permissions: { push: true } } };
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      if (isEmpty) return { status: 409, body: { message: 'Git Repository is empty.' } };
      const sha = gh.branches[m[1]];
      return sha ? { status: 200, body: { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (rest === '/git/refs' && method === 'POST') {
      const { ref, sha } = JSON.parse(body || '{}');
      const name = String(ref).replace('refs/heads/', '');
      if (gh.branches[name]) return { status: 422, body: { message: 'Reference already exists' } };
      if (!gh.commits[sha]) return { status: 422, body: { message: 'Object does not exist' } };
      gh.branches[name] = sha;
      return { status: 201, body: { ref, object: { sha } } };
    }
    if (/^\/contents\/?$/.test(rest) && method === 'GET') {
      if (isEmpty) return { status: 404, body: { message: 'This repository is empty.' } };
      const branch = u.searchParams.get('ref') || defaultBranch;
      if (!gh.branches[branch]) return { status: 404, body: { message: `No commit found for the ref ${branch}` } };
      return { status: 200, body: gh.listing('', branch) };
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      const file = m[1];
      if (method === 'GET') {
        if (isEmpty) return { status: 404, body: { message: 'This repository is empty.' } };
        const branch = u.searchParams.get('ref') || defaultBranch;
        if (!gh.branches[branch]) return { status: 404, body: { message: `No commit found for the ref ${branch}` } };
        const f = gh.file(file, branch);
        if (!f) {
          const list = gh.listing(file.replace(/\/+$/, ''), branch);
          return list.length ? { status: 200, body: list } : { status: 404, body: { message: 'Not Found' } };
        }
        const b64 = Buffer.from(f.text, 'utf8').toString('base64');
        return { status: 200, body: { path: file, sha: f.sha, encoding: 'base64', content: b64.match(/.{1,60}/g).join('\n') } };
      }
      if (method === 'PUT') {
        const b = JSON.parse(body || '{}');
        if (isEmpty && b.branch) return { status: 404, body: { message: `Branch ${b.branch} not found` } };
        const branch = b.branch || defaultBranch;
        if (!isEmpty && !gh.branches[branch]) return { status: 404, body: { message: `Branch ${branch} not found` } };
        const cur = gh.file(file, branch);
        if (cur && !b.sha) return { status: 422, body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } };
        if (cur && b.sha !== cur.sha) return { status: 409, body: { message: `${file} does not match ${b.sha}` } };
        if (!cur && b.sha) return { status: 404, body: { message: 'Not Found' } };
        const commit = gh.write(file, Buffer.from(b.content, 'base64').toString('utf8'), branch);
        return { status: cur ? 200 : 201, body: { content: { path: file, sha: gh.file(file, branch).sha }, commit: { sha: commit } } };
      }
    }
    if ((m = /^\/git\/blobs\/(.+)$/.exec(rest))) {
      const f = Object.values(gh.commits).flatMap((c) => Object.values(c)).find((x) => x.sha === m[1]);
      return f ? { status: 200, body: { sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64') } } : { status: 404, body: {} };
    }
    return { status: 500, body: { message: `ruta no simulada ${method} ${p}` } };
  };
  // fetch para usar el core desde Node con el mismo GitHub
  gh.fetch = async (url, init = {}) => {
    const r = gh.handle({ method: (init.method || 'GET').toUpperCase(), url: String(url), body: init.body });
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return gh;
}

// Publica en el GitHub simulado la copia (backup.json v3 + turnos.ics) de OTRO dispositivo
export async function seedRemote(gh, state, { deviceId = 'otro', key = KEY, now = new Date('2026-10-12T18:00:00Z'), dir = '', name } = {}) {
  let s = core.updateSettings(state, { sync: { ...SYNC, key, deviceId, dir } });
  if (name !== undefined) s = core.updateSettings(s, { name });
  const res = await core.syncNow(s, { fetchImpl: gh.fetch, now });
  if (!res.ok) throw new Error(`seedRemote: ${res.error?.code} ${res.error?.detail}`);
  return res;
}

// Simula GitHub (fakeGitHub) y ntfy.sh en la página (nada sale a internet). → { gh, github: [...], ntfy: [...] }
export async function mockNetwork(page, { gh = fakeGitHub(), githubStatus } = {}) {
  if (githubStatus) gh.status = githubStatus;
  const log = { gh, github: gh.log, ntfy: [] };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE' };
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const r = gh.handle({ method: req.method(), url: req.url(), body: req.postData() });
    return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: JSON.stringify(r.body) });
  });
  await page.route('https://ntfy.sh/**', async (route) => {
    const req = route.request();
    log.ntfy.push(`${req.method()} ${new URL(req.url()).pathname} ${req.postData() || ''}`.trim());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' });
  });
  return log;
}
