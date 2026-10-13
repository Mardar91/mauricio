// Entrada de la UI: crea el store, las pestañas, el service worker y las tareas de fondo.
import { createStore, parseSetupLink, toKey } from './core/index.js';
import { h, clear } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { closeAllSheets, sheetsOpen } from './ui/sheet.js';
import { confirmAndApplySetup } from './ui/setup.js';
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

// Debe coincidir con VERSION en sw.js
export const APP_VERSION = '1.1.0';

const TABS = [
  { id: 'hoy', label: 'Hoy', icon: 'today' },
  { id: 'calendario', label: 'Calendario', icon: 'calendar' },
  { id: 'escanear', label: 'Escanear', icon: 'camera', center: true },
  { id: 'horas', label: 'Horas', icon: 'hours' },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings' },
];

const store = createStore();
const views = {};
const scrollPos = {};
let current = null;

const ctx = {
  store,
  version: APP_VERSION,
  now: () => new Date(),
  today: () => toKey(new Date()),
  toast,
  go,
  openDay: (key, opts) => openDayEditor(ctx, key, opts),
  openCode: (code, opts) => openCodeEditor(ctx, code, opts),
  background: null,
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
  const handled = v.onShow?.(opts, prev === tab);
  if (!handled) window.scrollTo(0, prev === tab ? 0 : (scrollPos[tab] || 0));
}

function rerender(state) {
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
}

function updateTabDot(state) {
  const dot = document.querySelector('.tab[data-tab="ajustes"] .tab-dot');
  if (dot) dot.hidden = attentionCount(state, new Date()) === 0;
}

// Enlace #setup=… para configurar la sincronización (lo envía el desarrollador)
async function handleSetupLink() {
  const hash = location.hash || '';
  if (!/setup=/.test(hash)) return;
  const sync = parseSetupLink(hash);
  history.replaceState(null, '', location.pathname + location.search); // el token no se queda en la URL
  if (!sync) {
    toast('El enlace de configuración no es válido o está incompleto.', { type: 'error' });
    return;
  }
  await confirmAndApplySetup(ctx, sync);
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // Solo se recarga cuando el usuario pide actualizar (no en la primera instalación)
  let updateRequested = false;
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
      action: { label: 'Actualizar', run: () => { updateRequested = true; worker.postMessage({ type: 'SKIP_WAITING' }); } },
    });
  };
  navigator.serviceWorker.register('sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // Busca actualizaciones al volver a la app
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => { /* sin service worker: la app funciona igual online */ });
}

// Ganchos para tests (Playwright)
function exposeTestHooks() {
  window.__turnosTest = {
    store,
    go,
    version: APP_VERSION,
    injectScanResult: (result) => { go('escanear'); return views.escanear.showReview(result, { source: 'test' }); },
    background: () => ctx.background,
  };
}

function start() {
  buildShell();
  store.subscribe(rerender);
  updateTabDot(store.get());
  ctx.background = createBackground(ctx);
  exposeTestHooks();
  const state = store.get();
  go('hoy');
  document.documentElement.classList.add('ready');

  // Refresca la vista "Hoy" (cuenta atrás) cada 30 s
  setInterval(() => { if (current === 'hoy' && !document.hidden) views.hoy.tick?.(); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      for (const v of Object.values(views)) v.dirty = true;
      if (!sheetsOpen()) renderKeepingFocus(views[current], store.get());
    }
  });

  navigator.storage?.persist?.().catch(() => {});
  registerSW();

  if (/setup=/.test(location.hash)) {
    // Primero el enlace; después, si es la primera vez, la bienvenida
    handleSetupLink().finally(() => { if (!store.get().settings.onboardingDone) showOnboarding(ctx); });
  } else if (!state.settings.onboardingDone) {
    showOnboarding(ctx);
  }
  ctx.background.start();
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
      h('h1', {}, 'Algo ha fallado 😕'),
      h('p', {}, 'Cierra la app y vuelve a abrirla. Tus turnos siguen guardados en el teléfono.'),
      h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => location.reload() } }, 'Volver a intentar')));
  }
}
