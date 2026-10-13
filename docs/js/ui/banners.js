// Avisos fijos arriba de las pantallas: no se pudo guardar, datos de una versión más nueva y
// «estás en Safari» (en iPhone sin instalar los datos se pueden borrar solos).
import { exportBackup, toKey } from '../core/index.js';
import { h, isIOS, isStandalone, shareOrDownload } from './dom.js';
import { icon } from './icons.js';
import { openInstallSheet } from './install.js';

export const inSafariTab = () => isIOS() && !isStandalone();

function banner(cls, ic, title, text, action, testid) {
  return h('div', { class: ['banner', cls], role: cls === 'banner-alert' ? 'alert' : 'status', 'data-testid': testid },
    h('span', { class: 'banner-icon', 'aria-hidden': 'true' }, icon(ic)),
    h('div', { class: 'banner-body' },
      h('p', { class: 'banner-title' }, title),
      text ? h('p', { class: 'banner-text' }, text) : null,
      action ? h('button', { class: 'btn btn-sm banner-btn', type: 'button', on: { click: action.run } }, action.label) : null));
}

async function exportNow(ctx) {
  try {
    const json = exportBackup(ctx.store.get(), { now: ctx.now() });
    const res = await shareOrDownload(`turnos-mauricio-${toKey(ctx.now())}.json`, json, 'application/json');
    if (res === 'downloaded') ctx.toast('Copia descargada', { type: 'ok' });
  } catch (e) {
    ctx.toast(e.message || 'No se pudo exportar la copia.', { type: 'error' });
  }
}

// where: 'hoy' | 'escanear' | 'calendario' | 'horas' | 'ajustes'
export function banners(ctx, state, where) {
  const out = [];
  if (ctx.saveError?.()) {
    const dev = isIOS() ? 'iPhone' : 'dispositivo';
    out.push(banner('banner-alert', 'warning', `No se pudo guardar en este ${dev}`,
      'Tus últimos cambios se pueden perder al cerrar la app. Exporta una copia y pide ayuda.',
      { label: 'Exportar copia', run: () => exportNow(ctx) }, 'banner-save'));
  }
  if (state?.__newerSchema) {
    out.push(banner('banner-alert', 'refresh', 'Actualiza la app',
      'Tus datos son de una versión más nueva de la app. Actualízala antes de cambiar nada.',
      { label: 'Actualizar ahora', run: () => ctx.updateApp?.() }, 'banner-newer'));
  }
  if (inSafariTab() && (where === 'hoy' || where === 'escanear')) {
    out.push(banner('banner-warn', 'phone', 'Instala la app para no perder tus datos',
      'En Safari tus turnos se pueden borrar solos.',
      { label: 'Cómo instalarla', run: () => openInstallSheet(ctx) }, 'banner-safari'));
  }
  return out.length ? h('div', { class: 'banners' }, out) : null;
}
