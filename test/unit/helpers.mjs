// Utilidades compartidas por los tests unitarios (no es un test).
process.env.TZ = 'Europe/Berlin';

import { createDefaultState, setDay, updateSettings } from '../../docs/js/core/store.js';

// Configuración de sync de prueba (token con formato real, clave de 32 bytes)
export const TOKEN = `github_pat_${'A'.repeat(22)}_${'B'.repeat(59)}`;
export const KEY = Buffer.alloc(32, 7).toString('base64url');
export const OTHER_KEY = Buffer.alloc(32, 9).toString('base64url');
export const SYNC = { enabled: true, owner: 'Mardar91', repo: 'mauricio-datos', branch: '', token: TOKEN, key: KEY, deviceId: 'movil1' };
export const API = 'https://api.github.com';
export const REPO = '/repos/Mardar91/mauricio-datos';

export const T0 = new Date('2026-10-01T08:00:00Z');

// Estado con días { key: codes[] }
export function stateWith(days = {}, settings) {
  let s = createDefaultState();
  if (settings) s = updateSettings(s, settings);
  for (const [k, codes] of Object.entries(days)) s = setDay(s, k, codes, { now: T0, source: 'manual' });
  return s;
}

// Semana real de las fotos (12–18 oct 2026)
export const REAL_WEEK = {
  '2026-10-12': ['F1', 'F52'],
  '2026-10-13': ['S1', 'S51'],
  '2026-10-14': ['-'],
  '2026-10-15': ['S1', 'S31'],
  '2026-10-16': ['-'],
  '2026-10-17': ['N1', 'N51'],
  '2026-10-18': ['N1', 'N51'],
};

// localStorage en memoria
export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

// fetch simulado: handler(req) → { status, body } | Response | throws
export function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const req = {
      url: String(url),
      method: (init.method || 'GET').toUpperCase(),
      headers: { ...(init.headers || {}) },
      body: init.body === undefined ? undefined : init.body,
    };
    req.json = () => JSON.parse(req.body);
    calls.push(req);
    const r = await handler(req, calls);
    if (r instanceof Response) return r;
    const status = r?.status ?? 200;
    const body = r?.body === undefined ? null : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return new Response(status === 204 ? null : body, { status, headers: r?.headers || {} });
  };
  fn.calls = calls;
  return fn;
}

// GitHub simulado en memoria: commits con instantáneas de archivos, ramas, repo vacío y control de sha
export function fakeGitHub({ empty = false, defaultBranch = 'main', repoStatus = 200, hasPages = false } = {}) {
  const gh = { commits: {}, branches: {}, seq: 0, defaultBranch, beforePut: null, override: null };
  if (!empty) {
    gh.commits.c0 = { 'README.md': { sha: 'f0', text: '# datos' } };
    gh.branches[defaultBranch] = 'c0';
  }
  const filesOf = (branch) => gh.commits[gh.branches[branch]] || null;
  gh.file = (path, branch = defaultBranch) => filesOf(branch)?.[path] ?? null;
  gh.text = (path, branch) => gh.file(path, branch)?.text ?? null;
  gh.write = (path, text, branch = defaultBranch) => {
    const commit = `c${++gh.seq}`;
    gh.commits[commit] = { ...(filesOf(branch) || {}), [path]: { sha: `f${gh.seq}`, text } };
    gh.branches[branch] = commit;
    return commit;
  };
  gh.remove = (path, branch = defaultBranch) => {
    const files = { ...(filesOf(branch) || {}) };
    delete files[path];
    const commit = `c${++gh.seq}`;
    gh.commits[commit] = files;
    gh.branches[branch] = commit;
  };
  // Escrituras (PUT) recibidas, por archivo
  gh.puts = (path) => gh.fetch.calls.filter((c) => c.method === 'PUT' && (!path || c.url.endsWith(`/${path}`)));
  gh.fetch = mockFetch(async (req, calls) => {
    if (gh.override) { const r = await gh.override(req, calls); if (r) return r; }
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname);
    const isEmpty = !Object.keys(gh.branches).length;
    let m;
    if (p === REPO && req.method === 'GET') {
      if (repoStatus !== 200) return { status: repoStatus, body: { message: 'Not Found' } };
      return { body: { full_name: 'Mardar91/mauricio-datos', default_branch: defaultBranch, private: false, has_pages: hasPages, permissions: { push: true } } };
    }
    if ((m = /^\/repos\/Mardar91\/mauricio-datos\/git\/ref\/heads\/(.+)$/.exec(p)) && req.method === 'GET') {
      if (isEmpty) return { status: 409, body: { message: 'Git Repository is empty.' } };
      const sha = gh.branches[m[1]];
      return sha ? { body: { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (p === `${REPO}/git/refs` && req.method === 'POST') {
      const { ref, sha } = req.json();
      const name = ref.replace('refs/heads/', '');
      if (gh.branches[name]) return { status: 422, body: { message: 'Reference already exists' } };
      if (!gh.commits[sha]) return { status: 422, body: { message: 'Object does not exist' } };
      gh.branches[name] = sha;
      return { status: 201, body: { ref, object: { sha } } };
    }
    if ((m = /^\/repos\/Mardar91\/mauricio-datos\/contents\/(.+)$/.exec(p))) {
      const path = m[1];
      if (req.method === 'GET') {
        if (isEmpty) return { status: 404, body: { message: 'This repository is empty.' } };
        const branch = u.searchParams.get('ref') || defaultBranch;
        if (!gh.branches[branch]) return { status: 404, body: { message: `No commit found for the ref ${branch}` } };
        const f = gh.file(path, branch);
        if (!f) return { status: 404, body: { message: 'Not Found' } };
        const b64 = Buffer.from(f.text, 'utf8').toString('base64');
        return { body: { path, sha: f.sha, encoding: 'base64', content: b64.match(/.{1,60}/g).join('\n') } };
      }
      if (req.method === 'PUT') {
        const body = req.json();
        if (gh.beforePut) await gh.beforePut(path, body);
        if (isEmpty && body.branch) return { status: 404, body: { message: `Branch ${body.branch} not found` } };
        const branch = body.branch || defaultBranch;
        if (!isEmpty && !gh.branches[branch]) return { status: 404, body: { message: `Branch ${branch} not found` } };
        const cur = gh.file(path, branch);
        if (cur && !body.sha) return { status: 422, body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } };
        if (cur && body.sha !== cur.sha) return { status: 409, body: { message: `${path} does not match ${body.sha}` } };
        if (!cur && body.sha) return { status: 404, body: { message: 'Not Found' } };
        const commit = gh.write(path, Buffer.from(body.content, 'base64').toString('utf8'), branch);
        return { status: cur ? 200 : 201, body: { content: { path, sha: gh.file(path, branch).sha }, commit: { sha: commit } } };
      }
    }
    if ((m = /^\/repos\/Mardar91\/mauricio-datos\/git\/blobs\/(.+)$/.exec(p))) {
      const f = Object.values(gh.commits).flatMap((c) => Object.values(c)).find((x) => x.sha === m[1]);
      return f ? { body: { sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64') } } : { status: 404, body: {} };
    }
    return { status: 500, body: { message: `ruta no simulada ${req.method} ${p}` } };
  });
  return gh;
}
