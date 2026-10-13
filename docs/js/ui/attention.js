// Cosas que piden atención en Ajustes (punto en la pestaña): horarios sin confirmar y errores.
import { getCode, toKey } from '../core/index.js';

// Códigos sin confirmar usados en días de hoy en adelante (o en cualquier día si no hay futuros)
export function unconfirmedInUse(state, now = new Date()) {
  const today = toKey(now);
  const out = new Map();
  for (const [key, entry] of Object.entries(state.days || {})) {
    for (const c of entry.codes || []) {
      const def = getCode(state, c);
      if (def.confirmed === false && ['shift', 'event', 'other'].includes(def.kind)) {
        const prev = out.get(def.code);
        if (key >= today && (!prev || prev.next === null || key < prev.next)) out.set(def.code, { def, next: key });
        else if (!prev) out.set(def.code, { def, next: null });
      }
    }
  }
  return out;
}

export function attentionCount(state, now = new Date()) {
  let n = 0;
  for (const v of unconfirmedInUse(state, now).values()) if (v.next) n++;
  const s = state.settings || {};
  if (s.sync?.enabled && s.sync?.lastError) n++;
  if (s.ntfy?.enabled && s.ntfy?.lastError) n++;
  return n;
}
