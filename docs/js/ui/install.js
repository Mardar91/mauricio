// Instalar la app en la pantalla de inicio. iPhone: guía de Safari (iOS 26 y anteriores; los menús
// cambian según el país: se nombran las dos formas). Android: botón «Instalar la app» de Chrome
// (beforeinstallprompt) o guía del menú ⋮. La comparten la bienvenida, los avisos, Hoy y Ajustes.
import { h, isIOS } from './dom.js';
import { icon, moreIcon, shareIcon, toggleIcon } from './icons.js';
import { openSheet } from './sheet.js';
import { appleDevice, isIPad, platform } from './platform.js';

// ---------- Aviso de instalación de Chrome (Android y ordenador) ----------
let deferred = null;
const subs = new Set();
const notify = () => { for (const fn of [...subs]) { try { fn(); } catch (e) { console.error(e); } } };

export function initInstallPrompt(ctx) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // se ofrece con nuestro botón
    deferred = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
    ctx?.toast?.('Listo: la app ya está en tu pantalla de inicio.', { type: 'ok' });
  });
}

export const canPromptInstall = () => Boolean(deferred);
export function onInstallChange(fn) { subs.add(fn); return () => subs.delete(fn); }

// Muestra el aviso de Chrome → true si se instaló
export async function promptInstall() {
  const e = deferred;
  if (!e) return false;
  deferred = null; // un aviso solo se puede usar una vez
  notify();
  try {
    await e.prompt();
    const choice = await e.userChoice;
    return choice?.outcome === 'accepted';
  } catch {
    return false;
  }
}

// Botón grande «Instalar la app» (null si Chrome no lo ofrece ahora)
export function installButton({ cls = 'btn-primary btn-lg btn-block', onDone } = {}) {
  if (!canPromptInstall()) return null;
  return h('button', {
    class: ['btn', cls], type: 'button', 'data-testid': 'install-prompt',
    on: { click: async () => { const ok = await promptInstall(); onDone?.(ok); } },
  }, icon('download'), 'Instalar la app');
}

// Nombre del botón y su icono juntos (que el icono no quede solo en otra línea)
const term = (label, ic, after = '') => h('span', { class: 'nowrap' }, h('b', {}, label), ' ', ic, after);

export function installSteps({ compact = false } = {}) {
  return h('ol', { class: ['steps', 'install-steps', compact && 'steps-compact'], 'data-testid': 'install-steps' },
    isIPad()
      // iPad: «Compartir» está arriba, junto a la dirección (en algunos, dentro de «•••»)
      ? h('li', {}, 'Toca ', term('«Compartir»', shareIcon()), ' (arriba, junto a la dirección de la página; si no lo ves, toca primero ', term('«•••»', moreIcon(), ').'))
      : h('li', {}, isIOS() ? '' : 'En el iPhone, abre esta página en Safari. ',
        'Toca ', term('«•••»', moreIcon()), ' (abajo a la derecha) y luego ', term('«Compartir»', shareIcon(), '.'),
        h('span', { class: 'step-note step-note-block' }, '(En iPhones con iOS más antiguo, Compartir está abajo en el centro.)')),
    h('li', {}, 'Toca ', h('b', {}, '«Agregar a inicio»'), ' o ', h('b', {}, '«Añadir a pantalla de '),
      term('inicio»', icon('addSquare', 'icon icon-inline'), '.'), compact ? null : h('span', { class: 'step-note' }, ' Si no lo ves, baja un poco.')),
    h('li', {}, 'Deja activado ', term('«Abrir como app web»', toggleIcon(), '.')),
    h('li', {}, 'Toca ', h('b', {}, '«Agregar»'), ' (o «Añadir»). Listo: abre la app siempre desde el icono ', h('b', {}, '«Turnos»'), '.'));
}

// Android (Chrome): menú ⋮ → Instalar app
export function androidInstallSteps({ compact = false } = {}) {
  return h('ol', { class: ['steps', 'install-steps', compact && 'steps-compact'], 'data-testid': 'install-steps-android' },
    h('li', {}, 'En Chrome, toca el menú ', h('b', { class: 'kbd-dots' }, '⋮'), ' (arriba a la derecha).'),
    h('li', {}, 'Toca ', h('b', {}, '«Instalar app»'), ' o ', h('b', {}, '«Agregar a la pantalla principal»'), compact ? '.' : ' (también puede decir «Añadir a pantalla de inicio»).'),
    h('li', {}, 'Toca ', h('b', {}, '«Instalar»'), '. Listo: abre la app desde el icono ', h('b', {}, '«Turnos»'), '.'));
}

// Hoja con la guía (aviso de Safari, Hoy vacío y Ajustes)
export function openInstallSheet(ctx) {
  if (platform() !== 'ios') return openAndroidInstallSheet(ctx);
  const hasDays = Object.keys(ctx.store.get().days || {}).length > 0;
  const sheet = openSheet({
    title: 'Instalar la app',
    subtitle: 'Un minuto y tus turnos quedan a salvo',
    className: 'sheet-install',
    body: h('div', { class: 'install-body' },
      h('p', { class: 'install-why' }, `En Safari el ${appleDevice()} puede borrar los datos de la página si no la abres durante unos días. La app de la pantalla de inicio los guarda de verdad.`),
      installSteps(),
      hasDays ? h('div', { class: 'notice notice-info' }, icon('info'), h('p', {},
        h('b', {}, 'Ya tienes turnos aquí. '),
        'La app instalada empieza vacía: antes de instalarla, ve a Ajustes → Copia de seguridad → «Exportar», y después, en la app, «Importar».')) : null),
    footer: h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', on: { click: () => sheet.close() } }, 'Entendido'),
  });
  return sheet;
}

function openAndroidInstallSheet() {
  let sheet = null;
  const btn = installButton({ onDone: () => sheet?.close() });
  sheet = openSheet({
    title: 'Instalar la app',
    subtitle: 'Para abrirla con un toque, como cualquier app',
    className: 'sheet-install',
    body: h('div', { class: 'install-body' },
      btn,
      btn ? h('p', { class: 'hint center' }, 'Si no sale nada al tocarlo, hazlo desde el menú de Chrome:') : null,
      androidInstallSteps(),
      h('p', { class: 'hint' }, 'Tus turnos son los mismos en Chrome y en la app instalada.')),
    footer: h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', on: { click: () => sheet.close() } }, 'Entendido'),
  });
  return sheet;
}
