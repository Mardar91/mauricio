// Conectar el Calendario del iPhone: enlace de configuración (#setup=…), «Tengo un enlace» (pegar),
// paso «Suscribirme en el iPhone» y «Usar este dispositivo». Todo pasa por la cola única (ctx.syncQueue).
import { parseSetupLink } from '../core/index.js';
import { copyText, h, isIOS } from './dom.js';
import { icon } from './icons.js';
import { installSteps } from './install.js';
import { inSafariTab } from './banners.js';
import { alertDialog, busyDialog, confirmDialog, openSheet } from './sheet.js';
import { calendarReady, webcalUrl } from './syncStatus.js';

// Enlace recibido (al abrir la app con #setup=… o pegado). link: el enlace completo (para copiarlo).
export async function openSetupLink(ctx, cfg, link) {
  // Safari de iOS sin instalar: su almacenamiento no es el de la app. No se configura nada aquí.
  if (inSafariTab()) {
    showCopyLinkSheet(ctx, link);
    return false;
  }
  return runSetup(ctx, cfg);
}

// «Copia este enlace y pégalo dentro de la app Turnos»
function showCopyLinkSheet(ctx, link) {
  const copyBtn = h('button', {
    class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'setup-copy',
    on: { click: async () => {
      const ok = await copyText(link);
      if (ok) {
        copyBtn.textContent = '';
        copyBtn.append(icon('check'), 'Enlace copiado');
        ctx.toast('Enlace copiado. Ahora ábrelo en la app Turnos.', { type: 'ok' });
      } else {
        ctx.toast('No se pudo copiar. Vuelve al mensaje y copia el enlace desde allí.', { type: 'error' });
      }
    } },
  }, icon('copy'), 'Copiar el enlace');
  return openSheet({
    title: 'Abre el enlace en la app',
    subtitle: 'Este enlace es para la app Turnos, no para Safari',
    className: 'sheet-setup-safari',
    body: h('div', { class: 'setup-safari', 'data-testid': 'setup-safari' },
      h('div', { class: 'notice notice-warn' }, icon('phone'), h('p', {},
        h('b', {}, 'Copia este enlace y pégalo dentro de la app Turnos '), '(Ajustes → «Tengo un enlace»). ',
        'Aquí, en Safari, no se ha cambiado nada.')),
      h('ol', { class: 'steps' },
        h('li', {}, 'Toca ', h('b', {}, '«Copiar el enlace»'), ' (abajo).'),
        h('li', {}, 'Abre la app ', h('b', {}, 'Turnos'), ' desde el icono naranja de tu pantalla de inicio.'),
        h('li', {}, 'Ve a ', h('b', {}, 'Ajustes → «Tengo un enlace»'), ' y toca ', h('b', {}, '«Pegar el enlace»'), '.')),
      h('details', { class: 'guide guide-inline' },
        h('summary', {}, h('span', {}, '¿Todavía no tienes la app en la pantalla de inicio?'), icon('chevronDown', 'icon chev')),
        h('div', { class: 'guide-body' }, installSteps({ compact: true })))),
    footer: copyBtn,
  });
}

// Confirmar → comprobar (lee y descifra con una copia; si falla no cambia nada) → guardar → publicar
// o solo leer → paso «Suscribirme en el iPhone». opts.confirm: false en el formulario avanzado.
export async function runSetup(ctx, cfg, { confirm = true } = {}) {
  if (confirm) {
    const ok = await confirmDialog({
      icon: '🔗',
      title: 'Conectar el Calendario del iPhone',
      text: `Este enlace lo preparó quien te ayuda (${cfg.owner}/${cfg.repo}). Sirve para que tus turnos aparezcan en el Calendario del iPhone, con avisos. Tus horarios se podrán ver con el enlace del calendario (las notas no). ¿Lo conecto?`,
      ok: 'Sí, conectar',
      cancel: 'Ahora no',
    });
    if (!ok) return false;
  }
  const busy = busyDialog('Conectando con tu calendario…');
  let t;
  try {
    t = await ctx.syncQueue.setup(cfg);
  } catch (e) {
    t = { ok: false, error: { message: e?.message || 'No se pudo conectar.' } };
  } finally {
    busy.close();
  }
  if (!t.ok) {
    await alertDialog({ icon: '⚠️', title: 'No se pudo conectar', text: t.error?.message || 'No se pudo conectar.' });
    return false;
  }
  if (t.readOnly) {
    // Ya publica otro dispositivo (p. ej. el navegador de quien ayuda)
    const yes = await confirmDialog({
      icon: '📲',
      title: `¿Usar este ${isIOS() ? 'iPhone' : 'dispositivo'} para actualizar el calendario?`,
      text: 'Tu otra app dejará de hacerlo. Primero se juntan los turnos de los dos.',
      ok: 'Sí, usar este', cancel: 'No, solo leer',
    });
    if (yes) await becomePublisherNow(ctx);
  } else if (!t.error) {
    const b2 = busyDialog('Preparando tu calendario…');
    let r = null;
    try { r = await ctx.syncQueue.sync(); } finally { b2.close(); }
    if (r && !r.ok && r.error && !r.error.retry) await alertDialog({ icon: '⚠️', title: 'Falta un detalle', text: r.error.message });
  }
  ctx.go('ajustes', { section: 'calendar' });
  openSubscribeSheet(ctx);
  return true;
}

// «Usar este dispositivo» (tras confirmarlo): lee + fusiona + publica desde aquí
async function becomePublisherNow(ctx) {
  const busy = busyDialog('Juntando tus turnos…');
  let r;
  try { r = await ctx.syncQueue.becomePublisher(); } finally { busy.close(); }
  if (r?.ok) {
    ctx.toast('Listo: ahora el calendario se actualiza desde aquí', { type: 'ok' });
    return true;
  }
  await alertDialog({ icon: '⚠️', title: 'No se pudo cambiar', text: r?.error?.message || 'Inténtalo de nuevo más tarde.' });
  return false;
}

export async function takeOver(ctx) {
  const ok = await confirmDialog({
    icon: '📲',
    title: '¿Actualizar el calendario desde este dispositivo?',
    text: 'Tu otra app dejará de hacerlo. Primero se juntan los turnos de los dos.',
    ok: 'Sí, usar este', cancel: 'Ahora no',
  });
  if (!ok) return false;
  return becomePublisherNow(ctx);
}

// Botón grande «Suscribirme en el iPhone» (webcal). Desactivado mientras se prepara el calendario.
export function subscribeButton(ctx, sync, { block = true } = {}) {
  const url = webcalUrl(sync);
  const ready = calendarReady(sync) && Boolean(url);
  return h('a', {
    class: ['btn', 'btn-primary', 'btn-lg', block && 'btn-block', !ready && 'is-disabled'],
    href: ready ? url : '#', 'aria-disabled': ready ? 'false' : 'true', 'data-testid': 'webcal',
    on: { click: (e) => {
      if (ready) return;
      e.preventDefault();
      ctx.toast('Espera un momento: estamos preparando tu calendario.', { type: 'info' });
    } },
  }, ready ? icon('calendar') : h('span', { class: 'spinner spinner-sm spinner-white', 'aria-hidden': 'true' }),
  ready ? 'Suscribirme en el iPhone' : 'Preparando tu calendario…');
}

// Aviso que no puede faltar al suscribirse
export function alertsNotice() {
  return h('div', { class: 'notice notice-warn notice-strong', 'data-testid': 'alerts-notice' }, icon('bell'), h('p', {},
    h('b', {}, 'Importante: '), 'cuando el iPhone lo pregunte, desactiva ', h('b', {}, '«Eliminar alertas»'),
    '. Si no, el calendario no te avisará.'));
}

export function subscribeSteps() {
  return h('ol', { class: 'steps steps-compact' },
    h('li', {}, 'Toca ', h('b', {}, '«Suscribirme en el iPhone»'), '.'),
    h('li', {}, 'El iPhone pregunta si quieres suscribirte: toca ', h('b', {}, '«Suscribirse»'), '.'),
    h('li', {}, h('b', {}, 'Desactiva «Eliminar alertas»'), ' y toca ', h('b', {}, '«Agregar»'), ' (u «OK»).'));
}

// Último paso tras conectar: suscribirse en el Calendario del iPhone
export function openSubscribeSheet(ctx) {
  const btnHost = h('div', { class: 'subscribe-btn-host' });
  const paint = () => {
    const s = ctx.store.get().settings.sync;
    btnHost.replaceChildren(subscribeButton(ctx, s));
  };
  paint();
  const unsub = ctx.store.subscribe(paint);
  return openSheet({
    title: 'Último paso: tu calendario',
    subtitle: 'Así el iPhone te avisa antes de cada turno',
    className: 'sheet-subscribe',
    body: h('div', { class: 'subscribe-body', 'data-testid': 'subscribe-step' },
      alertsNotice(),
      subscribeSteps(),
      h('p', { class: 'hint' }, 'Tus turnos aparecen en la app Calendario en unos minutos. Lo puedes repetir cuando quieras en Ajustes → Calendario del iPhone.')),
    footer: btnHost,
    onClose: unsub,
  });
}

// «Tengo un enlace»: pegar con un toque (portapapeles) o en el recuadro
export function openPasteSetup(ctx, { renew = false } = {}) {
  const area = h('textarea', {
    class: 'input textarea input-mono', rows: '3', placeholder: 'https://…#setup=…', autocapitalize: 'off', autocomplete: 'off',
    spellcheck: 'false', 'aria-label': 'Enlace de configuración', 'data-testid': 'setup-paste',
  });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const showError = (msg) => { err.textContent = msg; err.hidden = !msg; };

  async function useText(text) {
    const value = String(text || '').trim();
    const cfg = parseSetupLink(value);
    if (!cfg) {
      showError(value
        ? 'Ese enlace no sirve. Copia el enlace completo que te enviaron (empieza por https:// y lleva «#setup=»).'
        : 'Primero pega el enlace en el recuadro.');
      return;
    }
    showError('');
    sheet.close();
    await openSetupLink(ctx, cfg, value);
  }

  const canRead = Boolean(navigator.clipboard?.readText);
  const pasteBtn = canRead ? h('button', {
    class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'setup-paste-clip',
    on: { click: async () => {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch { text = ''; }
      if (text && parseSetupLink(text.trim())) { area.value = text.trim(); useText(text); return; }
      area.focus();
      showError(text ? 'Lo copiado no es un enlace de configuración. Vuelve al mensaje y copia el enlace.'
        : 'No se pudo pegar solo. Mantén el dedo en el recuadro, toca «Pegar» y después «Conectar».');
    } },
  }, icon('copy'), 'Pegar el enlace') : null;

  const sheet = openSheet({
    title: renew ? 'Tengo un enlace nuevo' : 'Tengo un enlace',
    subtitle: 'El enlace de configuración que te envió quien te ayuda',
    className: 'sheet-paste',
    body: h('div', { class: 'paste-setup' },
      h('ol', { class: 'steps steps-compact' },
        h('li', {}, 'En el mensaje, mantén el dedo sobre el enlace y toca ', h('b', {}, '«Copiar»'), '.'),
        h('li', {}, 'Vuelve aquí y toca ', h('b', {}, canRead ? '«Pegar el enlace»' : '«Pegar»'), canRead ? '.' : ' en el recuadro.')),
      pasteBtn,
      h('label', { class: 'field' }, h('span', { class: 'label' }, canRead ? 'O pégalo aquí:' : 'Enlace:'), area),
      err),
    footer: h('button', { class: ['btn', canRead ? 'btn-secondary' : 'btn-primary', 'btn-lg', 'btn-block'], type: 'button', 'data-testid': 'setup-paste-go', on: { click: () => useText(area.value) } }, 'Conectar'),
    isDirty: () => area.value.trim().length > 0,
    dirtyText: 'El enlace que pegaste no se usará.',
  });
  return sheet;
}
