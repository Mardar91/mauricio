// Notificaciones push opcionales con ntfy (sin cuenta): mensajes programados con sequence ID.
// Doc: https://docs.ntfy.sh/publish/ (JSON a la raíz del servidor, 'delay' hasta 3 días,
// mismo 'sequence_id' = reemplaza el programado, DELETE /<topic>/<sequence_id> = cancela).
import { upcomingReminders } from './reminders.js';
import { defaultFetch, hashString, stableStringify } from './util.js';

export const DEFAULT_SERVER = 'https://ntfy.sh';
export const MIN_LEAD_MS = 15 * 1000;          // ntfy exige al menos 10 s de retraso
export const HORIZON_MS = 70 * 3600 * 1000;    // máximo de ntfy.sh: 3 días
export const KEEPALIVE_ID = 'turnos-keepalive';
const KEEPALIVE_KEEP_MS = 50 * 3600 * 1000;    // no se reprograma si aún queda más que esto
const LOOKAHEAD_MS = 21 * 24 * 3600 * 1000;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// 'turnos-mauricio-xxxxxxxxxxxx' (12 caracteres aleatorios)
export function randomTopic(getRandomValues) {
  const grv = getRandomValues
    ?? (globalThis.crypto?.getRandomValues ? (a) => globalThis.crypto.getRandomValues(a) : null);
  let out = '';
  while (out.length < 12) {
    const buf = new Uint8Array(16);
    if (grv) grv(buf);
    else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    for (const b of buf) {
      if (b < 252 && out.length < 12) out += ALPHABET[b % 36]; // 252 = 7·36, sin sesgo
    }
  }
  return `turnos-mauricio-${out}`;
}

// Sequence ID válido para ntfy: letras, números, '-' y '_' (máx. 64)
export function sequenceId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

const serverOf = (ntfy) => String(ntfy?.server || DEFAULT_SERVER).trim().replace(/\/+$/, '');

export function topicUrl(ntfy) {
  return `${serverOf(ntfy)}/${encodeURIComponent(ntfy?.topic || '')}`;
}

// En iPhone/iPad un enlace de notificación abre Safari (otra copia de la app, con otros datos),
// nunca la app de la pantalla de inicio: allí no se añade enlace.
export function isAppleMobile(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  return /iPhone|iPad|iPod/.test(ua) || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
}

function defaultAppUrl() {
  const loc = globalThis.location;
  if (isAppleMobile()) return undefined;
  return loc && /^https?:/.test(loc.protocol) ? `${loc.origin}${loc.pathname}` : undefined;
}

function httpError(status) {
  if (status === 429) return 'ntfy: demasiados avisos seguidos. Se volverá a intentar más tarde.';
  if (status === 401 || status === 403) return 'ntfy: este tema está protegido. Usa otro nombre de tema.';
  if (status === 413) return 'ntfy: el mensaje es demasiado largo.';
  if (status >= 500) return 'ntfy no responde en este momento. Se volverá a intentar más tarde.';
  return `ntfy respondió con un error (${status}).`;
}

const NETWORK_MSG = 'No hay conexión con ntfy. Comprueba internet.';

// Error que detiene la sincronización (sin red o límite de peticiones)
function fail(message, stop = false) {
  const e = new Error(message);
  e.stop = stop;
  return e;
}

// Publica como JSON en la raíz del servidor. Sin Content-Type para evitar la petición previa CORS.
async function publish(fetchImpl, server, payload) {
  let res;
  try {
    res = await fetchImpl(`${server}/`, { method: 'POST', body: JSON.stringify(payload) });
  } catch {
    throw fail(NETWORK_MSG, true);
  }
  if (!res.ok) throw fail(httpError(res.status), res.status === 429);
  return res;
}

async function cancel(fetchImpl, server, topic, seq) {
  let res;
  try {
    res = await fetchImpl(`${server}/${encodeURIComponent(topic)}/${encodeURIComponent(seq)}`, { method: 'DELETE' });
  } catch {
    throw fail(NETWORK_MSG, true);
  }
  if (!res.ok && res.status !== 404) throw fail(httpError(res.status), res.status === 429);
}

const unix = (date) => String(Math.floor(date.getTime() / 1000));

function reminderPayload(topic, rem, appUrl) {
  const p = {
    topic,
    sequence_id: sequenceId(rem.id),
    title: rem.title,
    message: rem.body,
    tags: rem.tag ? [rem.tag] : [],
    priority: rem.type === 'pre' ? 4 : 3,
    delay: unix(rem.at),
  };
  if (appUrl) p.click = appUrl;
  return p;
}

// Hora del aviso "abre la app": ~70 h, pero de día (entre las 9 y las 20 h)
function keepAliveTime(now) {
  const t = new Date(now.getTime() + HORIZON_MS);
  if (t.getHours() < 9) return new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1, 20, 0);
  if (t.getHours() >= 21) return new Date(t.getFullYear(), t.getMonth(), t.getDate(), 20, 0);
  return t;
}

// Programa los recordatorios de las próximas ~70 h, reemplaza los cambiados y cancela los obsoletos.
// Devuelve { scheduled (mapa nuevo para settings.ntfy.scheduled), published, cancelled, errors,
//            nextScheduled: Date|null, ntfy (settings.ntfy actualizado para guardar) }.
export async function syncNtfy(state, now = new Date(), fetchImpl = defaultFetch, { appUrl = defaultAppUrl() } = {}) {
  const ntfy = state?.settings?.ntfy || {};
  const server = serverOf(ntfy);
  const topic = String(ntfy.topic || '').trim();
  const active = Boolean(ntfy.enabled && topic);
  const old = { ...(ntfy.scheduled || {}) };
  const next = {};
  const published = [], cancelled = [], errors = [];
  const t = now.getTime();
  let stopped = false; // sin red o con límite: no se insiste en esta ronda
  const onError = (e) => { errors.push(e.message); if (e.stop) stopped = true; };

  // Deseados: recordatorios entre ahora+15 s y ahora+70 h
  const desired = new Map();
  let beyond = false;
  if (active) {
    for (const rem of upcomingReminders(state, now, LOOKAHEAD_MS)) {
      const at = rem.at.getTime();
      if (at > t + HORIZON_MS) { beyond = true; continue; }
      if (at < t + MIN_LEAD_MS) continue;
      const payload = reminderPayload(topic, rem, appUrl);
      desired.set(payload.sequence_id, { payload, at: rem.at });
    }
  }

  // 1) Cancelar los que ya no hacen falta (los pasados se olvidan sin más)
  for (const [seq, entry] of Object.entries(old)) {
    const at = new Date(entry?.at).getTime();
    if (!Number.isFinite(at) || at <= t) continue;
    const sameTarget = (entry.topic ?? topic) === topic && (entry.server ?? server) === server;
    const wanted = desired.has(seq) || (seq === KEEPALIVE_ID && active && beyond);
    if (wanted && sameTarget) { next[seq] = entry; continue; }
    if (at < t + MIN_LEAD_MS) { next[seq] = entry; continue; } // a punto de salir: se deja
    const eTopic = entry.topic || topic;
    if (!eTopic) continue;
    if (stopped) { next[seq] = entry; continue; }
    try {
      await cancel(fetchImpl, entry.server || server, eTopic, seq);
      cancelled.push(seq);
    } catch (e) {
      onError(e);
      next[seq] = entry; // se reintenta la próxima vez
    }
  }

  // 2) Publicar los nuevos o cambiados
  for (const [seq, { payload, at }] of desired) {
    const hash = hashString(stableStringify({ server, ...payload }));
    const prev = next[seq];
    if ((prev && prev.hash === hash) || stopped) continue;
    try {
      await publish(fetchImpl, server, payload);
      next[seq] = { at: at.toISOString(), hash, topic, server };
      published.push(seq);
    } catch (e) {
      onError(e);
    }
  }

  // 3) Aviso para mantener los recordatorios si hay turnos más allá del horizonte
  if (active && beyond && !stopped) {
    const prev = next[KEEPALIVE_ID];
    const keep = prev && prev.topic === topic && new Date(prev.at).getTime() - t > KEEPALIVE_KEEP_MS;
    if (!keep) {
      const at = keepAliveTime(now);
      // Sin enlace: tocar el aviso abriría Safari, no la app instalada (que es la que programa)
      const payload = {
        topic, sequence_id: KEEPALIVE_ID, title: 'Abre la app Turnos',
        message: 'Abre Turnos desde su icono en la pantalla de inicio (no desde este aviso) para seguir recibiendo los avisos de tus turnos.',
        tags: ['bell'], priority: 3, delay: unix(at),
      };
      try {
        await publish(fetchImpl, server, payload);
        next[KEEPALIVE_ID] = { at: at.toISOString(), hash: hashString(stableStringify({ server, ...payload })), topic, server };
        published.push(KEEPALIVE_ID);
      } catch (e) {
        onError(e);
      }
    }
  }

  const upcoming = Object.entries(next)
    .filter(([seq, e]) => seq !== KEEPALIVE_ID && new Date(e.at).getTime() > t)
    .map(([, e]) => new Date(e.at))
    .sort((a, b) => a - b);
  const uniqueErrors = [...new Set(errors)];
  return {
    scheduled: next,
    published,
    cancelled,
    errors: uniqueErrors,
    nextScheduled: upcoming[0] ?? null,
    ntfy: { ...ntfy, scheduled: next, lastRunAt: now.toISOString(), lastError: uniqueErrors[0] ?? null },
  };
}

// Notificación de prueba inmediata → { ok, message }
export async function testNtfy(ntfy, fetchImpl = defaultFetch, { appUrl = defaultAppUrl() } = {}) {
  const topic = String(ntfy?.topic || '').trim();
  if (!topic) return { ok: false, message: 'Primero elige un nombre de tema (topic).' };
  const payload = {
    topic,
    title: 'Turnos de Mauricio',
    message: '¡Funciona! Así te llegarán los avisos de tus turnos. 👍',
    tags: ['white_check_mark'],
    priority: 3,
  };
  if (appUrl) payload.click = appUrl;
  try {
    await publish(fetchImpl, serverOf(ntfy), payload);
    return { ok: true, message: 'Notificación de prueba enviada. Mira tu iPhone.' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
