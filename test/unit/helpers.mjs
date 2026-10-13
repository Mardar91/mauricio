// Utilidades compartidas por los tests unitarios (no es un test).
process.env.TZ = 'Europe/Berlin';

import { createDefaultState, setDay, updateSettings } from '../../docs/js/core/store.js';

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
