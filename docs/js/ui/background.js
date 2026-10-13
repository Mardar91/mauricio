// Tareas de fondo: publicar en GitHub (calendario) y programar avisos de ntfy tras cada cambio.
import { pushData, syncNtfy, updateSettings } from '../core/index.js';

const PUSH_DELAY = 4000;      // espera tras un cambio antes de publicar
const NTFY_DELAY = 2500;
const PERIODIC = 30 * 60 * 1000;

// Clave de los datos que afectan al calendario y a los avisos (sin metadatos de sincronización)
function dataKey(state) {
  const s = state.settings;
  return JSON.stringify([state.days, state.codes, s.reminders, s.weeklyHours, s.workDaysPerWeek,
    s.sync.enabled, s.sync.owner, s.sync.repo, s.sync.branch, s.sync.token,
    s.ntfy.enabled, s.ntfy.topic, s.ntfy.server]);
}

export function createBackground(ctx) {
  const { store } = ctx;
  let lastKey = null;
  let pushTimer = null, ntfyTimer = null;
  let pushing = null, ntfying = null;
  let pushAgain = false, ntfyAgain = false;

  const online = () => navigator.onLine !== false;

  async function runPush({ manual = false, force = false } = {}) {
    const s = store.get().settings.sync;
    if (!s.enabled || !s.token) return manual ? { ok: false, message: 'La sincronización no está activada.' } : null;
    if (!online()) {
      if (manual) return { ok: false, message: 'Sin conexión a internet. Se enviará cuando vuelva la conexión.' };
      return null;
    }
    if (pushing) { pushAgain = true; return pushing; }
    pushing = (async () => {
      try {
        const res = await pushData(store.get(), { now: new Date(), force });
        const cur = store.get().settings.sync;
        if (res.pushed || cur.lastError || cur.lastPushHash !== res.hash) {
          store.set((st) => updateSettings(st, { sync: { lastPushAt: res.sync.lastPushAt ?? st.settings.sync.lastPushAt, lastPushHash: res.hash, lastError: null } }));
        }
        return { ok: true, pushed: res.pushed, message: res.pushed ? 'Calendario actualizado.' : 'El calendario ya estaba al día.' };
      } catch (e) {
        const message = e?.message || 'No se pudo enviar a GitHub.';
        if (store.get().settings.sync.lastError !== message) {
          store.set((st) => updateSettings(st, { sync: { lastError: message } }));
        }
        return { ok: false, message };
      } finally {
        pushing = null;
        if (pushAgain) { pushAgain = false; schedulePush(); }
      }
    })();
    return pushing;
  }

  async function runNtfy({ manual = false } = {}) {
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

  function schedulePush(delay = PUSH_DELAY) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => runPush(), delay);
  }

  function scheduleNtfy(delay = NTFY_DELAY) {
    clearTimeout(ntfyTimer);
    ntfyTimer = setTimeout(() => runNtfy(), delay);
  }

  function onChange(state) {
    const key = dataKey(state);
    if (key === lastKey) return;
    lastKey = key;
    schedulePush();
    scheduleNtfy();
  }

  return {
    start() {
      lastKey = dataKey(store.get());
      store.subscribe(onChange);
      // Al abrir la app: comprobar ambos (no hacen nada si no hay cambios)
      schedulePush(1500);
      scheduleNtfy(1200);
      window.addEventListener('online', () => { schedulePush(500); scheduleNtfy(500); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { schedulePush(1500); scheduleNtfy(1000); }
      });
      setInterval(() => { if (!document.hidden) { runNtfy(); runPush(); } }, PERIODIC);
    },
    syncNow: (opts) => { clearTimeout(pushTimer); return runPush(opts); },
    ntfyNow: (opts) => { clearTimeout(ntfyTimer); return runNtfy(opts); },
    busy: () => Boolean(pushing || ntfying),
  };
}
