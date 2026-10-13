// Guías para ver los turnos en el calendario del teléfono según la plataforma (SPEC §12):
// iPhone/iPad (suscripción webcal), Android (recomendado: app ICSx⁵, que guarda los avisos; alternativa:
// Google Calendar «Desde una URL» desde una computadora) y ordenador. Las usan Ajustes, el último paso
// tras conectar y «Calendarios de la familia».
import { copyText, h } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, openSheet } from './sheet.js';
import { appleDevice, platform } from './platform.js';

// Abre una dirección (dentro del mismo toque, para que iOS y Android la acepten)
export function openUrl(url) {
  const a = h('a', { href: url, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
}

// Botón «Copiar enlace» (dirección https del calendario)
export function copyLinkButton(ctx, url, { label = 'Copiar enlace', cls = 'btn-secondary btn-block', testid = 'copy-cal-link' } = {}) {
  return h('button', {
    class: ['btn', cls], type: 'button', 'data-testid': testid,
    on: { click: async () => {
      const ok = await copyText(url);
      ctx.toast(ok ? 'Enlace copiado' : 'No se pudo copiar', { type: ok ? 'ok' : 'error' });
    } },
  }, icon('copy'), label);
}

// El enlace a la vista, con «Copiar» al lado (para pegarlo a mano)
export function copyLine(ctx, url) {
  return h('div', { class: 'copy-line' },
    h('code', {}, url),
    h('button', { class: 'btn btn-tinted btn-sm', type: 'button', on: { click: async () => { const ok = await copyText(url); ctx.toast(ok ? 'Enlace copiado' : 'No se pudo copiar', { type: ok ? 'ok' : 'error' }); } } },
      icon('copy'), 'Copiar'));
}

const steps = (items, cls = '') => h('ol', { class: ['steps', cls] }, items.map((it) => h('li', {}, it)));
const b = (t) => h('b', {}, t);
const guide = (fkey, summary, ...content) => h('details', { class: 'guide guide-inline', dataset: { fkey } },
  h('summary', {}, h('span', {}, summary), icon('chevronDown', 'icon chev')), h('div', { class: 'guide-body' }, content));

// Android, paso a paso con ICSx⁵ (v2.4: la 1.ª pantalla tiene «SUBSCRIBE» abajo y → arriba; la 2.ª,
// solo → arriba, que crea la suscripción; abierta desde el enlace, ICSx⁵ se cierra al terminar).
// other: es el calendario de otra persona (sin sus avisos)
export function icsx5Steps({ calName = 'Mis turnos', buttonLabel = 'Ver mis turnos en el calendario', other = false } = {}) {
  return steps([
    ['En el teléfono, abre Google Play, busca ', b('«ICSx⁵»'), ' (de bitfire) e instálala (cuesta 1,99 €; también es gratis en F-Droid).'],
    ['Abre ICSx⁵ una vez y toca ', b('«Permitir»'), ' cuando pida acceso al calendario (y a las notificaciones, si lo pide).'],
    ['Vuelve a la app Turnos y toca ', b(`«${buttonLabel}»`), '. Si el teléfono pregunta con qué abrirlo, elige ', b('«ICSx⁵»'), '.',
      h('span', { class: 'step-note step-note-block' }, 'Si no se abre: toca «Copiar enlace», abre ICSx⁵, toca el botón «+» y pega el enlace en «Webcal address».')],
    ['Toca ', b('«SUBSCRIBE»'), ' (abajo) o la flecha ', b('→'), ' (arriba a la derecha) y espera a que compruebe el enlace.'],
    ['En ', b('«Título y color»'), ' escribe un nombre, por ejemplo ', b(`«${calName}»`), ', y elige un color.'],
    other
      ? ['En la sección ', b('«Alarms»'), ' (aparece en inglés): activa ', b('«Ignore alerts embedded in the calendar»'), '. Así ves sus turnos sin recibir sus avisos.']
      : ['En la sección ', b('«Alarms»'), ' (aparece en inglés): deja ', b('apagado'), ' «Ignore alerts embedded in the calendar» y deja ', b('vacío'), ' «Add default alarm». Los avisos ya vienen incluidos en el calendario de Turnos.'],
    ['Para terminar, toca la flecha ', b('→'), ' (arriba a la derecha; en esta pantalla ya no hay botón abajo). ICSx⁵ guarda la suscripción y se cierra (o vuelve a su lista).'],
    ['Abre la app ', b('ICSx⁵'), ' desde su icono. En «Mis suscripciones» verás ', b(`«${calName}»`), '. Toca el menú ', b('⋮'), ' (arriba a la derecha) → ', b('«Marcar intervalo de sincronización»'), ' → ', b('«Cada hora»'), '.'],
    ['Si ICSx⁵ muestra un aviso de batería, tócalo y elige ', b('«Sin restricciones»'), ' (o ve a Ajustes del teléfono → Aplicaciones → ICSx⁵ → Batería → «Sin restricciones»).'],
    ['Abre tu app de calendario (Google Calendar o Calendario de Samsung). En el menú, revisa que ', b(`«${calName}»`), ' esté marcado (está en la cuenta «Suscripciones de calendario»).'],
    other ? null : ['Revisa que la app de calendario pueda mostrar notificaciones: Ajustes del teléfono → Aplicaciones → Calendario → Notificaciones → activadas.'],
    [b('Listo. '), 'Los cambios que hagas en Turnos llegan al teléfono en una hora como máximo', other ? '.' : ', con sus avisos.'],
  ].filter(Boolean), 'steps-guide');
}

// Pasos cortos (Ajustes antes de suscribirse y el último paso tras conectar)
export function icsx5ShortSteps({ buttonLabel = 'Ver mis turnos en el calendario' } = {}) {
  return steps([
    ['Instala ', b('«ICSx⁵»'), ' desde Google Play (cuesta 1,99 €) y ábrela una vez: toca «Permitir».'],
    ['Vuelve aquí y toca ', b(`«${buttonLabel}»`), '. Si pregunta con qué abrirlo, elige «ICSx⁵».'],
    ['En ICSx⁵ toca ', b('«SUBSCRIBE»'), '. En «Alarms» deja ', b('apagado'), ' «Ignore alerts embedded in the calendar» y, para terminar, toca la flecha ', b('→'), ' (arriba).'],
    ['ICSx⁵ se cierra. Después ábrela desde su icono: menú ⋮ → «Marcar intervalo de sincronización» → ', b('«Cada hora»'), '.'],
  ], 'steps-compact');
}

// Google Calendar «Desde una URL» (gratis, pero desde una computadora y lento)
export function googleSteps({ other = false } = {}) {
  return h('div', { class: 'guide-stack' },
    steps([
      ['En una computadora, abre ', b('calendar.google.com'), ' con la misma cuenta de Google que usas en el teléfono. (Desde la app del teléfono no se puede.)'],
      ['En la app Turnos toca ', b('«Copiar enlace»'), ' y pásalo a la computadora (por ejemplo, enviándotelo por correo).'],
      ['En Google Calendar, a la izquierda, junto a «Otros calendarios», haz clic en ', b('«+»'), ' («Agregar otros calendarios» o «Añadir otros calendarios») y luego en ', b('«Desde una URL»'), ' («Desde URL»).'],
      ['Pega el enlace y haz clic en ', b('«Agregar calendario»'), ' («Añadir calendario»). Aparecerá en «Otros calendarios».'],
      other ? null : [b('Importante para los avisos: '), 'pasa el ratón sobre el calendario nuevo → ⋮ → «Configuración». En «Notificaciones de eventos», haz clic en «Agregar notificación» y elige, por ejemplo, 60 minutos. Google no usa los avisos que trae el calendario de Turnos.'],
      ['En el teléfono Android, abre Google Calendar → menú ☰ → «Configuración» (o «Ajustes»). Toca el calendario de turnos (si no aparece, toca «Mostrar más») y activa ', b('«Sincronizar»'), '.'],
    ].filter(Boolean), 'steps-guide'),
    h('p', { class: 'hint' }, h('b', {}, 'Ojo: '), 'Google tarda varias horas (a veces hasta un día) en ver los cambios y no se puede forzar. Tampoco avisa la víspera a una hora fija ni tiene en cuenta el tiempo de viaje. Por eso es mejor ICSx⁵.'));
}

// Las dos guías de Android, plegadas: la recomendada primero
export function androidGuides(ctx, { calName, buttonLabel, other = false, open = false } = {}) {
  const g1 = guide(other ? 'guide-icsx5-other' : 'guide-icsx5', 'Paso a paso con la app ICSx⁵ (recomendado)', icsx5Steps({ calName, buttonLabel, other }));
  if (open) g1.open = true;
  return [g1, guide(other ? 'guide-google-other' : 'guide-google', 'Otra opción: Google Calendar (gratis, desde una computadora)', googleSteps({ other }))];
}

// «Ver sus turnos en mi calendario» de otra persona. iPhone/iPad: primero un aviso (dejar ACTIVADO
// «Eliminar alertas», al revés que con el calendario propio); el webcal se abre desde el botón del
// aviso, en el mismo toque. Android y ordenador: hoja con las guías.
export function openFamilyCalendar(ctx, cal) {
  if (platform() !== 'ios') return openFamilyCalendarSheet(ctx, cal);
  const dev = appleDevice();
  return confirmDialog({
    icon: '👀',
    title: `Turnos de ${cal.label}: solo para mirar`,
    text: h('div', { 'data-testid': 'family-ios-notice' },
      h('p', { class: 'dialog-strong' }, `Cuando el ${dev} lo pregunte, deja `, h('b', {}, 'ACTIVADO'), ' «Eliminar alertas».'),
      h('p', {}, 'Así ves sus turnos sin que te suenen sus avisos: no llevan su nombre y los confundirías con los tuyos. (Con tu propio calendario es al revés.)')),
    ok: 'Entendido, suscribirme', cancel: 'Ahora no',
    onOk: () => openUrl(cal.urls.webcal),
  });
}

// Hoja «Ver sus turnos en mi calendario» de otra persona (Android y ordenador)
export function openFamilyCalendarSheet(ctx, cal) {
  const name = cal.label;
  const plat = platform();
  const btnLabel = 'Ver sus turnos en mi calendario';
  const body = h('div', { class: 'install-body', 'data-testid': 'family-guide' },
    h('p', { class: 'install-why' }, `Así ves los turnos de ${name} en tu calendario, por ejemplo para cambiar un turno. Solo para mirar: no te llegan sus avisos.`),
    plat === 'android' ? h('a', { class: 'btn btn-primary btn-lg btn-block', href: cal.urls.android, 'data-testid': 'family-open-android' }, icon('calendar'), btnLabel) : null,
    copyLinkButton(ctx, cal.urls.https, { testid: 'family-copy' }),
    ...androidGuides(ctx, { calName: `Turnos de ${name}`, buttonLabel: btnLabel, other: true, open: plat === 'android' }),
    plat === 'desktop' ? h('p', { class: 'hint' }, 'En un iPhone o un iPad: abre allí la app Turnos, ve a Ajustes → «Calendarios de la familia» y toca «Ver sus turnos en mi calendario».') : null);
  const sheet = openSheet({
    title: `Turnos de ${name}`,
    subtitle: 'En tu calendario, solo para mirar',
    className: 'sheet-family',
    body,
    footer: h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', on: { click: () => sheet.close() } }, 'Cerrar'),
  });
  return sheet;
}
