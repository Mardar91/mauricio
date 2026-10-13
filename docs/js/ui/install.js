// Guía para añadir la app a la pantalla de inicio (iPhone). La comparten la bienvenida, el aviso de
// Safari y Ajustes. Los menús de iOS cambian según el país: se nombran las dos formas.
import { h, isIOS } from './dom.js';
import { icon, shareIcon } from './icons.js';
import { openSheet } from './sheet.js';

export function installSteps({ compact = false } = {}) {
  return h('ol', { class: ['steps', compact && 'steps-compact'] },
    h('li', {}, isIOS() ? 'En Safari, toca el botón ' : 'En el iPhone, abre esta página en Safari y toca ',
      h('b', {}, 'Compartir'), ' ', shareIcon(), ' (abajo, en el centro).'),
    h('li', {}, 'Baja un poco y toca ', h('b', {}, '«Agregar a inicio»'), ' o ', h('b', {}, '«Añadir a pantalla de inicio»'),
      ' ', icon('addSquare', 'icon icon-inline'), ' (el cuadrado con +).'),
    h('li', {}, 'Toca ', h('b', {}, '«Agregar»'), ' (o «Añadir»), arriba a la derecha.'),
    h('li', {}, 'Abre la app siempre desde el icono naranja ', h('b', {}, '«Turnos»'), '.'));
}

// Hoja con la guía (desde el aviso de Safari)
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
