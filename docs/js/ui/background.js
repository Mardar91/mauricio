// Tareas de fondo: mantener al día el Calendario del iPhone (sincronización con GitHub, siempre por
// la cola única ctx.syncQueue) y programar los avisos de ntfy (opcional) tras cada cambio.
import { syncNtfy, updateSettings } from '../core/index.js';
import { isIOS, isStandalone } from './dom.js';
import { maybeAskTakeover } from './setup.js';

const SYNC_DELAY = 1500;       // espera corta tras un cambio (junta varios toques seguidos)
const NTFY_DELAY = 1500;
const PERIODIC = 30 * 60 * 1000;
const RETRY_STEPS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];

// Lo que importa para publicar (CORE-API §4.3)
function syncKey(state) {
  const s = state.settings || {};
  const y = s.sync || {};
  return JSON.stringify([state.days, state.tombstones, state.codes, state.codeTombstones, s.reminders,
    y.enabled, y.owner, y.repo, y.branch, y.token, y.key, y.publishPlaces]);
}

function ntfyKey(state) {
  const s = state.settings || {};
  const n = s.ntfy || {};
  return JSON.stringify([state.days, state.codes, s.reminders, n.enabled, n.topic, n.server]);
}

export function createBackground(ctx) {
  const { store } = ctx;
  let lastSyncKey = null, lastNtfyKey = null;
  let syncTimer = null, ntfyTimer = null, retryTimer = null, retryStep = 0;
  let running = 0;
  let ntfying = null, ntfyAgain = false;
  const busySubs = new Set();

  const online = () => navigator.onLine !== false;
  // En Safari de iOS sin instalar nunca se sincroniza solo (sus datos no son los de la app)
  const autoAllowed = () => !(isIOS() && !isStandalone());

  function setBusy(d) {
    const was = running > 0;
    running = Math.max(0, running + d);
    if (was !== running > 0) for (const fn of [...busySubs]) { try { fn(running > 0); } catch (e) { console.error(e); } }
  }

  // §4.3 runSync: devuelve el resultado de la cola (o null si no toca)
  async function runSync({ manual = false, force = false } = {}) {
    const s = store.get().settings.sync;
    if (!s.enabled) {
      if (manual) ctx.toast('El calendario no está conectado.', { type: 'error' });
      return null;
    }
    if (!manual && !autoAllowed()) return null;
    if (!manual && !online()) return null; // se intentará con el evento 'online'
    clearTimeout(syncTimer); syncTimer = null;
    setBusy(+1);
    let res;
    try {
      res = await ctx.syncQueue.sync(force ? { force: true } : undefined);
    } catch (e) {
      console.error(e);
      res = { ok: false, error: { message: 'No se pudo actualizar el calendario.', retry: true } };
    } finally {
      setBusy(-1);
    }
    if (manual) {
      ctx.toast(res.ok ? (res.readOnly ? 'Datos al día (este dispositivo solo lee).' : 'Calendario actualizado.') : res.error.message,
        { type: res.ok ? 'ok' : 'error', duration: res.ok ? undefined : 7000 });
    }
    if (res.keyRestored) ctx.toast('La clave nueva no servía para tus turnos guardados: se sigue usando la anterior.', { type: 'info', duration: 7000 });
    // Conectado sin internet: ahora que se sabe quién publica, quizá haya que preguntar «¿Usar este iPhone?»
    maybeAskTakeover(ctx, res).catch((e) => console.error(e));
    if (res.ok) {
      retryStep = 0;
      clearTimeout(retryTimer); retryTimer = null;
    } else if (res.error?.retry) {
      scheduleRetry();
    }
    return res;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    const d = RETRY_STEPS[Math.min(retryStep, RETRY_STEPS.length - 1)];
    retryStep++;
    retryTimer = setTimeout(() => { retryTimer = null; runSync(); }, d);
  }

  async function runNtfy({ manual = false } = {}) {
    clearTimeout(ntfyTimer); ntfyTimer = null;
    const n = store.get().settings.ntfy;
    const hasScheduled = Object.keys(n.scheduled || {}).length > 0;
    if (!n.enabled && !hasScheduled) return null; // nada que programar ni cancelar
    if (!online()) return manual ? { ok: false, message: 'Sin conexión a internet.' } : null;
    if (ntfying) { ntfyAgain = true; return ntfying; }
    ntfying = (async () => {
      try {
        const res = await syncNtfy(store.get(), new Date());
        const cur = store.get().settings.ntfy;
        const changed = res.published.length || res.cancelled.length || (cur.lastError || null) !== (res.ntfy.lastError || null)
          || JSON.stringify(cur.scheduled) !== JSON.stringify(res.scheduled);
        if (changed || manual) {
          store.set((st) => updateSettings(st, { ntfy: { scheduled: res.scheduled, lastRunAt: res.ntfy.lastRunAt, lastError: res.ntfy.lastError } }));
        }
        return { ok: !res.errors.length, message: res.errors[0] || 'Avisos programados.', result: res };
      } catch (e) {
        return { ok: false, message: e?.message || 'No se pudieron programar los avisos.' };
      } finally {
        ntfying = null;
        if (ntfyAgain) { ntfyAgain = false; scheduleNtfy(); }
      }
    })();
    return ntfying;
  }

  function scheduleSync(delay = SYNC_DELAY) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; runSync(); }, delay);
  }

  function scheduleNtfy(delay = NTFY_DELAY) {
    clearTimeout(ntfyTimer);
    ntfyTimer = setTimeout(() => { ntfyTimer = null; runNtfy(); }, delay);
  }

  function onChange(state) {
    const k = syncKey(state);
    if (k !== lastSyncKey) { lastSyncKey = k; scheduleSync(); }
    const n = ntfyKey(state);
    if (n !== lastNtfyKey) { lastNtfyKey = n; scheduleNtfy(); }
  }

  // iOS congela la app poco después de salir: lo pendiente se lanza ya
  function flush() {
    if (ntfyTimer) runNtfy();
    if (syncTimer) runSync();
  }

  return {
    start() {
      lastSyncKey = syncKey(store.get());
      lastNtfyKey = ntfyKey(store.get());
      store.subscribe(onChange);
      // Al abrir la app
      scheduleSync(SYNC_DELAY);
      scheduleNtfy(1200);
      window.addEventListener('online', () => { scheduleSync(500); scheduleNtfy(500); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
        else { scheduleSync(SYNC_DELAY); scheduleNtfy(1000); }
      });
      window.addEventListener('pagehide', flush);
      setInterval(() => { if (!document.hidden) { runNtfy(); runSync(); } }, PERIODIC);
    },
    runSync,
    syncNow: (opts = {}) => runSync({ manual: true, ...opts }),
    ntfyNow: (opts) => runNtfy(opts),
    flush,
    busy: () => running > 0,
    onBusy(fn) { busySubs.add(fn); return () => busySubs.delete(fn); },
  };
}
