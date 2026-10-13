// Entrada de la UI: crea el store y la cola de sincronización, las pestañas, el service worker y las
// tareas de fondo.
import { createStore, createSyncQueue, ensureSyncIdentity, parseSetupLink, toKey, updateSettings } from './core/index.js';
import { h, clear, safeStorage } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { closeAllSheets, confirmDialog, sheetsOpen } from './ui/sheet.js';
import { openSetupLink } from './ui/setup.js';
import { createToday } from './ui/today.js';
import { createCalendar } from './ui/calendar.js';
import { createScan } from './ui/scan.js';
import { createHours } from './ui/hours.js';
import { createSettings } from './ui/settings.js';
import { openDayEditor } from './ui/dayEditor.js';
import { openCodeEditor } from './ui/codeEditor.js';
import { showOnboarding } from './ui/onboarding.js';
import { createBackground } from './ui/background.js';
import { attentionCount } from './ui/attention.js';
import { initInstallPrompt, onInstallChange } from './ui/install.js';
import { platform } from './ui/platform.js';
import { inSafariTab } from './ui/banners.js';
import { createOcrPrefetch } from './ui/prefetch.js';

// Debe coincidir con VERSION en sw.js
export const APP_VERSION = '1.4.2';

const TABS = [
  { id: 'hoy', label: 'Hoy', icon: 'today' },
  { id: 'calendario', label: 'Calendario', icon: 'calendar' },
  { id: 'escanear', label: 'Escanear', icon: 'camera', center: true },
  { id: 'horas', label: 'Horas', icon: 'hours' },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings' },
];

const storage = safeStorage();
// Último fallo al guardar (cuota llena, almacenamiento bloqueado): banner rojo hasta que vuelva a ir bien
let saveError = storage ? null : { code: 'NO_STORAGE' };
const store = createStore(storage, {
  onError: (e) => {
    saveError = e;
    console.warn('[store] no se pudo guardar', e?.code, e?.detail);
  },
});
const syncQueue = createSyncQueue(store);
const views = {};
const scrollPos = {};
let current = null;
let swReg = null;

const ctx = {
  store,
  syncQueue,
  version: APP_VERSION,
  platform: platform(), // 'ios' | 'android' | 'desktop'
  now: () => new Date(),
  today: () => toKey(new Date()),
  toast,
  go,
  openDay: (key, opts) => openDayEditor(ctx, key, opts),
  openCode: (code, opts) => openCodeEditor(ctx, code, opts),
  background: null,
  saveError: () => saveError,
  updateApp,
  updateChrome,
  resetScan: () => views.escanear?.reset?.(),
  // Re-pinta la vista activa (p. ej. tras algo guardado fuera del store, como «Suscrito ✓»)
  repaint: () => { if (current && views[current]) renderKeepingFocus(views[current], store.get()); },
};

function buildShell() {
  const app = document.getElementById('app');
  clear(app);
  const main = h('main', { id: 'views' });
  const nav = h('nav', { class: 'tabbar', 'aria-label': 'Secciones' },
    TABS.map((t) => h('button', {
      class: ['tab', t.center && 'tab-center'], type: 'button', dataset: { tab: t.id },
      'aria-label': t.label, on: { click: () => go(t.id) },
    },
    t.center ? h('span', { class: 'tab-center-disc' }, icon(t.icon)) : icon(t.icon),
    h('span', { class: 'tab-label' }, t.label),
    t.id === 'ajustes' ? h('span', { class: 'tab-dot', hidden: true, 'aria-hidden': 'true' }) : null)));
  app.append(main, nav);

  views.hoy = createToday(ctx);
  views.calendario = createCalendar(ctx);
  views.escanear = createScan(ctx);
  views.horas = createHours(ctx);
  views.ajustes = createSettings(ctx);
  for (const [id, v] of Object.entries(views)) {
    v.el.classList.add('view');
    v.el.id = `view-${id}`;
    v.el.hidden = true;
    v.dirty = true;
    main.append(v.el);
  }
}

// Cambia de pestaña. opts se pasa a la vista (p. ej. { year, month } para el calendario)
function go(tab, opts) {
  if (!views[tab]) return;
  if (sheetsOpen()) closeAllSheets();
  const prev = current;
  if (prev && prev !== tab) {
    scrollPos[prev] = window.scrollY;
    views[prev].el.hidden = true;
    views[prev].onHide?.();
  }
  current = tab;
  const v = views[tab];
  if (v.dirty) { v.render(store.get()); v.dirty = false; }
  v.el.hidden = false;
  for (const b of document.querySelectorAll('.tab')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  document.body.dataset.tab = tab;
  document.documentElement.dataset.tab = tab; // scroll-padding del calendario (barra del mes fija)
  updateChrome();
  const handled = v.onShow?.(opts, prev === tab);
  if (!handled) window.scrollTo(0, prev === tab ? 0 : (scrollPos[tab] || 0));
}

// Sin barra de pestañas mientras se revisa un escaneo (la barra de «Guardar» ocupa su sitio)
function updateChrome() {
  const focus = current === 'escanear' && views.escanear && views.escanear.mode !== 'home';
  document.body.classList.toggle('focus-mode', Boolean(focus));
}

function rerender(state) {
  if (saveError && store.saveOk() && storage) saveError = null;
  for (const [id, v] of Object.entries(views)) {
    if (id === current) renderKeepingFocus(v, state);
    else v.dirty = true;
  }
  updateTabDot(state);
}

// Re-pinta la vista activa conservando el foco y el scroll
function renderKeepingFocus(v, state) {
  const active = document.activeElement;
  const fkey = active && v.el.contains(active) ? active.dataset.fkey : null;
  let sel = null;
  try { sel = fkey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null; } catch { sel = null; }
  // Texto a medio escribir (aún sin 'change') y secciones desplegadas
  const typing = fkey && /^(INPUT|TEXTAREA)$/.test(active.tagName) && active.type !== 'checkbox' ? active.value : null;
  const openDetails = new Set([...v.el.querySelectorAll('details[data-fkey][open]')].map((d) => d.dataset.fkey));
  const y = window.scrollY;
  v.render(state);
  v.dirty = false;
  for (const d of v.el.querySelectorAll('details[data-fkey]')) if (openDetails.has(d.dataset.fkey)) d.open = true;
  if (fkey) {
    const el = v.el.querySelector(`[data-fkey="${CSS.escape(fkey)}"]`);
    if (el) {
      if (typing !== null && el.value !== typing) el.value = typing;
      el.focus({ preventScroll: true });
      if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* no aplica */ }
    }
  }
  window.scrollTo(0, y);
  updateChrome();
}

function updateTabDot(state) {
  const dot = document.querySelector('.tab[data-tab="ajustes"] .tab-dot');
  if (dot) dot.hidden = attentionCount(state, new Date()) === 0;
}

// Enlace #setup=… (lo envía quien ayuda): se limpia la URL enseguida (lleva el token)
async function handleSetupLink() {
  const hash = location.hash || '';
  if (!/setup=/.test(hash)) return false;
  const link = location.href;
  const cfg = parseSetupLink(hash);
  history.replaceState(null, '', location.pathname + location.search);
  if (!cfg) {
    toast('Ese enlace no sirve: no es válido o está incompleto. Pide que te lo envíen otra vez.', { type: 'error', duration: 7000 });
    return false;
  }
  return openSetupLink(ctx, cfg, link);
}

// «Actualizar» (banner de datos más nuevos): busca la versión nueva y recarga
async function updateApp() {
  try {
    const reg = swReg || (await navigator.serviceWorker?.getRegistration?.());
    await reg?.update?.();
    if (reg?.waiting) {
      updateRequested = true;
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
  } catch { /* sin service worker */ }
  location.reload();
}

let updateRequested = false;

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // Solo se recarga cuando el usuario pide actualizar (no en la primera instalación)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested) return;
    updateRequested = false;
    location.reload();
  });
  let offered = false;
  const offer = (worker) => {
    if (offered) return;
    offered = true;
    toast('Hay una nueva versión de la app.', {
      duration: 0,
      // Si se cierra sin «Actualizar» (un toque, o la apartan otros avisos), se vuelve a ofrecer al volver
      onClose: (reason) => { if (reason !== 'action') offered = false; },
      action: {
        label: 'Actualizar',
        run: async () => {
          // Lo que se está editando en una hoja, una foto que se está leyendo o las fotos de una
          // revisión (el borrador se guarda, pero las fotos no) se perderían
          const scan = views.escanear;
          const photosOpen = scan && scan.mode !== 'home' && scan.photoCount > 0;
          const busy = sheetsOpen() || scan?.mode === 'processing' || photosOpen;
          if (busy && !(await confirmDialog({
            title: '¿Actualizar ahora?',
            text: photosOpen && !sheetsOpen()
              ? 'Tu revisión se guarda, pero las fotos se cerrarán (no podrás volver a verlas). Puedes actualizar después.'
              : 'Se cerrará lo que estás haciendo sin guardar. Puedes actualizar después.',
            ok: 'Actualizar', cancel: 'Ahora no',
          }))) { offered = false; return; }
          ctx.background?.flush();
          updateRequested = true;
          worker.postMessage({ type: 'SKIP_WAITING' });
        },
      },
    });
  };
  navigator.serviceWorker.register('sw.js').then((reg) => {
    swReg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // Busca actualizaciones al volver a la app (y vuelve a ofrecer una que se aplazó)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      reg.update().catch(() => {});
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    });
  }).catch(() => { /* sin service worker: la app funciona igual online */ });
}

// Ganchos para tests (Playwright)
function exposeTestHooks() {
  window.__turnosTest = {
    store,
    syncQueue,
    go,
    version: APP_VERSION,
    injectScanResult: (result) => { go('escanear'); return views.escanear.showReview(result, { source: 'test' }); },
    background: () => ctx.background,
    prefetch: () => ctx.prefetch,
  };
}

// Al volver a la app: releer lo guardado (otra pestaña o la app pudo cambiarlo) y re-pintar
function onReturn() {
  store.refresh();
  for (const v of Object.values(views)) v.dirty = true;
  if (!sheetsOpen()) renderKeepingFocus(views[current], store.get());
}

// Botón «Instalar la app» de Chrome (Android): el aviso puede llegar en cualquier momento
initInstallPrompt(ctx);

function start() {
  document.documentElement.dataset.platform = ctx.platform;
  // Identidad de la sincronización antes de la primera petición (dispositivos ya conectados)
  const s0 = store.get().settings.sync;
  if (s0.enabled && !s0.deviceId) store.set((s) => ensureSyncIdentity(s, { key: false }));

  buildShell();
  store.subscribe(rerender);
  updateTabDot(store.get());
  ctx.background = createBackground(ctx);
  ctx.background.onBusy(() => { if (current === 'ajustes' && !sheetsOpen()) renderKeepingFocus(views[current], store.get()); });
  onInstallChange(() => { views.ajustes.dirty = true; if (current === 'ajustes' && !sheetsOpen()) renderKeepingFocus(views[current], store.get()); });
  exposeTestHooks();
  const state = store.get();

  // Un plan a medio revisar (la app se cerró o se actualizó): se sigue donde estaba
  const draft = views.escanear.draftInfo?.();
  if (draft && Date.now() - draft.at < 6 * 3600 * 1000 && !/setup=/.test(location.hash)) go('escanear');
  else {
    go('hoy');
    if (draft) toast('Tienes un plan a medio revisar.', { action: { label: 'Seguir', run: () => go('escanear') }, duration: 8000 });
  }
  document.documentElement.classList.add('ready');

  // Refresca la vista "Hoy" (cuenta atrás) cada 30 s
  setInterval(() => { if (current === 'hoy' && !document.hidden && !sheetsOpen()) views.hoy.tick?.(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onReturn(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) onReturn(); });

  navigator.storage?.persist?.().catch(() => {});
  registerSW();

  if (/setup=/.test(location.hash)) {
    // Primero el enlace. Si se conectó, el propio enlace ya guio (y queda abierto el paso de suscribirse);
    // si no, después la bienvenida
    let shown = null;
    handleSetupLink().then((applied) => {
      shown = applied;
      if (applied === true && !store.get().settings.onboardingDone) store.set((s) => updateSettings(s, { onboardingDone: true }));
    }).catch((e) => console.error(e)).finally(() => {
      // En Safari el enlace abrió «Copia este enlace…»: la bienvenida la taparía (y quien tiene el enlace
      // normalmente ya tiene la app). Saldrá la próxima vez que se abra sin enlace.
      if (shown === 'safari') return;
      if (!store.get().settings.onboardingDone) showOnboarding(ctx);
    });
  } else if (!state.settings.onboardingDone) {
    showOnboarding(ctx);
  }
  ctx.background.start();

  // Lector de fotos sin conexión: descarga en segundo plano lo que usará el primer escaneo. No en
  // Safari sin instalar (su almacenamiento no es el de la app). __turnosPrefetch: solo para tests
  // (false = no; { delay } = antes).
  ctx.prefetch = createOcrPrefetch({ isBusy: () => Boolean(views.escanear && views.escanear.mode !== 'home') });
  const pf = window.__turnosPrefetch;
  if (pf !== false && !inSafariTab()) ctx.prefetch.start(pf && typeof pf.delay === 'number' ? { delay: pf.delay } : undefined);
}

window.addEventListener('hashchange', () => { if (/setup=/.test(location.hash)) handleSetupLink(); });

try {
  start();
} catch (e) {
  console.error(e);
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = '';
    app.append(h('div', { class: 'fatal' },
      h('h1', {}, 'Algo falló 😕'),
      h('p', {}, 'Cierra la app y vuelve a abrirla. Tus turnos siguen guardados en el teléfono.'),
      h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => location.reload() } }, 'Volver a intentar')));
  }
}
