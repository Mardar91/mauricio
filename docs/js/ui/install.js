// Guía para añadir la app a la pantalla de inicio (iPhone, Safari de iOS 26 y anteriores). La comparten
// la bienvenida, el aviso de Safari, el enlace abierto en Safari y Ajustes. Los menús de iOS cambian
// según el país: se nombran las dos formas.
import { h, isIOS } from './dom.js';
import { icon, moreIcon, shareIcon, toggleIcon } from './icons.js';
import { openSheet } from './sheet.js';

// Nombre del botón y su icono juntos (que el icono no quede solo en otra línea)
const term = (label, ic, after = '') => h('span', { class: 'nowrap' }, h('b', {}, label), ' ', ic, after);

export function installSteps({ compact = false } = {}) {
  return h('ol', { class: ['steps', 'install-steps', compact && 'steps-compact'], 'data-testid': 'install-steps' },
    h('li', {}, isIOS() ? '' : 'En el iPhone, abre esta página en Safari. ',
      'Toca ', term('«•••»', moreIcon()), ' (abajo a la derecha) y luego ', term('«Compartir»', shareIcon(), '.'),
      h('span', { class: 'step-note step-note-block' }, '(En iPhones con iOS más antiguo, Compartir está abajo en el centro.)')),
    h('li', {}, 'Toca ', h('b', {}, '«Agregar a inicio»'), ' o ', h('b', {}, '«Añadir a pantalla de '),
      term('inicio»', icon('addSquare', 'icon icon-inline'), '.'), compact ? null : h('span', { class: 'step-note' }, ' Si no lo ves, baja un poco.')),
    h('li', {}, 'Deja activado ', term('«Abrir como app web»', toggleIcon(), '.')),
    h('li', {}, 'Toca ', h('b', {}, '«Agregar»'), ' (o «Añadir»). Listo: abre la app siempre desde el icono ', h('b', {}, '«Turnos»'), '.'));
}

// Hoja con la guía (aviso de Safari, Hoy vacío y Ajustes en Safari)
export function openInstallSheet(ctx) {
  const hasDays = Object.keys(ctx.store.get().days || {}).length > 0;
  const sheet = openSheet({
    title: 'Instalar la app',
    subtitle: 'Un minuto y tus turnos quedan a salvo',
    className: 'sheet-install',
    body: h('div', { class: 'install-body' },
      h('p', { class: 'install-why' }, 'En Safari el iPhone puede borrar los datos de la página si no la abres durante unos días. La app de la pantalla de inicio los guarda de verdad.'),
      installSteps(),
      hasDays ? h('div', { class: 'notice notice-info' }, icon('info'), h('p', {},
        h('b', {}, 'Ya tienes turnos aquí. '),
        'La app instalada empieza vacía: antes de instalarla, ve a Ajustes → Copia de seguridad → «Exportar», y después, en la app, «Importar».')) : null),
    footer: h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', on: { click: () => sheet.close() } }, 'Entendido'),
  });
  return sheet;
}
