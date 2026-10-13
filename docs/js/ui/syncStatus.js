// Estado del Calendario del iPhone en palabras sencillas (Hoy y Ajustes). Sin jerga.
import { calendarUrls, isReadOnlyDevice } from '../core/index.js';
import { ago, h, plural, safeStorage } from './dom.js';
import { icon } from './icons.js';

// Errores pasajeros (sin red, servicio ocupado…): se reintenta solo
export const TRANSIENT = ['NETWORK', 'SERVER', 'RATE_LIMIT', 'CONFLICT', 'RETRY'];
// Errores que se arreglan actualizando la app (no con un enlace nuevo)
export const NEWER = ['NEWER_REMOTE', 'NEWER_LOCAL'];

// Qué arregla un error: 'update' (actualizar la app), 'pull' (traer los turnos de internet) o 'link'
export function errorRemedy(code) {
  if (NEWER.includes(code)) return 'update';
  if (code === 'EMPTY_LOCAL') return 'pull';
  return 'link';
}

// ---------- «Ya me suscribí» (por dispositivo) ----------
// Suscribirse dos veces a la misma dirección duplica cada turno (y sus avisos) en el Calendario.
// Se recuerda en este dispositivo qué dirección se tocó y cuándo.
export const SUBSCRIBED_KEY = 'turnos-mauricio:subscribed';

export function subscribedInfo() {
  try {
    const v = JSON.parse(safeStorage()?.getItem(SUBSCRIBED_KEY) || 'null');
    return v && typeof v.url === 'string' ? v : null;
  } catch { return null; }
}

export function markSubscribed(url, now = new Date()) {
  if (!url) return;
  try { safeStorage()?.setItem(SUBSCRIBED_KEY, JSON.stringify({ url, at: now.toISOString() })); } catch { /* sin espacio */ }
}

// ¿Este dispositivo ya se suscribió a la dirección actual del calendario?
export function isSubscribed(sync) {
  const url = webcalUrl(sync);
  return Boolean(url && subscribedInfo()?.url === url);
}

export function isConfigured(sync) {
  return Boolean(sync?.owner && sync?.repo && sync?.token);
}

// Última vez que se comprobó que el calendario publicado está al día
export function lastSyncAt(sync) {
  return [sync?.lastPushAt, sync?.lastPullAt].filter(Boolean).sort().pop() || null;
}

// ¿Se puede suscribir ya? (el calendario existe en internet)
export function calendarReady(sync) {
  return Boolean(sync?.enabled && isConfigured(sync) && (sync.lastPushAt || sync.lastPullAt || sync.lastIcsHash));
}

export function webcalUrl(sync) {
  return sync?.owner && sync?.repo ? calendarUrls(sync).webcal : null;
}

// → { kind: 'off'|'busy'|'pending'|'ok'|'readonly'|'transient'|'error', title, text, line }
// line: frase corta para la pantalla Hoy
export function syncState(state, now = new Date(), { busy = false } = {}) {
  const s = state?.settings?.sync || {};
  if (!s.enabled || !isConfigured(s)) {
    return {
      kind: 'off', title: 'Sin conectar',
      text: 'Tus turnos todavía no salen en el Calendario del iPhone.',
      line: null,
    };
  }
  const last = lastSyncAt(s);
  const when = last ? ago(last, now) : '';
  if (s.lastError && !TRANSIENT.includes(s.lastErrorCode)) {
    const remedy = errorRemedy(s.lastErrorCode);
    return {
      kind: 'error', title: 'El calendario no se está actualizando', code: s.lastErrorCode || null, remedy,
      text: s.lastError,
      line: remedy === 'update' ? 'Actualiza la app para que el Calendario del iPhone siga al día.'
        : remedy === 'pull' ? 'El Calendario del iPhone no se está actualizando: faltan tus turnos en este teléfono.'
          : 'El Calendario del iPhone no se está actualizando. Pide ayuda a quien te configuró la app.',
    };
  }
  if (busy) {
    return { kind: 'busy', title: 'Actualizando el calendario…', text: last ? `Última vez: ${when}.` : '', line: 'Actualizando el Calendario del iPhone…' };
  }
  if (s.lastError) {
    const fresh = !last;
    return {
      kind: 'transient', title: fresh ? 'Preparando tu calendario' : 'Pendiente de actualizar',
      text: s.lastError,
      line: fresh ? 'El calendario se conectará cuando haya internet.' : `Calendario sin actualizar desde ${when}: se intentará de nuevo solo.`,
    };
  }
  if (isReadOnlyDevice(s)) {
    const n = Number(s.unpublished) || 0;
    return {
      kind: 'readonly', title: 'Este dispositivo solo lee',
      text: 'El calendario lo actualiza otro dispositivo (por ejemplo, el de quien te ayuda).' + (n ? ` Hay ${plural(n, 'cambio', 'cambios')} aquí que no ${n === 1 ? 'está' : 'están'} en el calendario.` : ''),
      line: n ? 'Hay cambios aquí que no están en el Calendario del iPhone.' : null,
    };
  }
  if (!last) {
    return { kind: 'pending', title: 'Preparando tu calendario…', text: 'En un momento estará listo.', line: 'Preparando el Calendario del iPhone…' };
  }
  return { kind: 'ok', title: 'Conectado', text: `Al día · actualizado ${when}.`, line: `Calendario del iPhone al día · ${when}` };
}

// Línea de estado para Hoy (null si no hay nada que decir). Sin «Actualizando…»: en Hoy no parpadea
export function syncStatusLine(ctx, state) {
  const st = syncState(state, ctx.now());
  if (!st.line) return null;
  const tone = { ok: 'ok', busy: 'muted', pending: 'muted', transient: 'muted', readonly: 'warn', error: 'alert' }[st.kind] || 'muted';
  const ic = { ok: 'check', busy: 'refresh', pending: 'refresh', transient: 'cloud', readonly: 'info', error: 'warning' }[st.kind] || 'info';
  const tappable = ['error', 'readonly', 'transient'].includes(st.kind);
  const inner = [h('span', { class: 'sync-line-icon', 'aria-hidden': 'true' }, icon(ic)), h('span', { class: 'sync-line-text' }, st.line),
    tappable ? h('span', { class: 'sync-line-more', 'aria-hidden': 'true' }, icon('chevronRight')) : null];
  return tappable
    ? h('button', { class: ['sync-line', `sync-${tone}`], type: 'button', 'data-testid': 'sync-line', on: { click: () => ctx.go('ajustes', { section: 'calendar' }) } }, inner)
    : h('p', { class: ['sync-line', `sync-${tone}`], 'data-testid': 'sync-line' }, inner);
}
