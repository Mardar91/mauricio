// Conectar el calendario del teléfono: enlace de configuración (#setup=…), «Tengo un enlace» (pegar),
// último paso para suscribirse (iPhone: webcal; Android: ICSx⁵) y «Usar este dispositivo». Todo pasa
// por la cola única (ctx.syncQueue).
import { calendarName, calendarUrls, parseSetupLink, publicName } from '../core/index.js';
import { copyText, dateTime, h, safeStorage, setChildren } from './dom.js';
import { icon } from './icons.js';
import { installSteps } from './install.js';
import { inSafariTab } from './banners.js';
import { alertDialog, busyDialog, confirmDialog, openSheet, sheetsOpen } from './sheet.js';
import {
  TRANSIENT, calendarReady, isConfigured, isSubscribed, markSubscribed, subscribedInfo, webcalUrl,
} from './syncStatus.js';
import { appleDevice, calendarPhrase, deviceWord, platform, subscribeLabel } from './platform.js';
import { androidGuides, copyLinkButton, icsx5ShortSteps, openUrl } from './calguide.js';

// Conectado sin internet y sin saber aún quién publica: se pregunta en la primera sincronización
const ASK_TAKEOVER_KEY = 'turnos-mauricio:ask-takeover';

// Enlace recibido (al abrir la app con #setup=… o pegado). link: el enlace completo (para copiarlo).
// → true (conectado) | false | 'safari' (se mostró «Copia este enlace…»: no hay que tapar esa hoja)
export async function openSetupLink(ctx, cfg, link) {
  // Safari de iOS sin instalar: su almacenamiento no es el de la app. No se configura nada aquí.
  if (inSafariTab()) {
    showCopyLinkSheet(ctx, link);
    return 'safari';
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

// Texto del botón «Crear enlace…» para este calendario (el de la persona de este dispositivo)
export function ownLinkLabel(state) {
  const n = publicName(state?.settings?.name || '');
  return n ? `Crear enlace para ${n}` : 'Crear enlace de configuración';
}

// Confirmar → comprobar (lee y descifra con una copia; si falla no cambia nada) → guardar → publicar
// o solo leer → paso «Suscribirme en el iPhone» (o iPad; solo si hace falta). opts.confirm: false en el
// formulario avanzado.
// helper: se conecta desde «Opciones avanzadas» (normalmente quien ayuda): no se adueña del
// calendario ni pide suscribirse; lleva a «Crear enlace…»
export async function runSetup(ctx, cfg, { confirm = true, helper = false } = {}) {
  if (confirm) {
    const cal = calendarPhrase();
    const who = cfg?.name ? publicName(cfg.name) : '';
    const ok = await confirmDialog({
      icon: '🔗',
      title: `Conectar el ${cal}`,
      text: `Este enlace lo preparó quien te ayuda${who ? ` para ${who}` : ''}. Así tus turnos salen en el ${cal}, con avisos. ¿Lo conecto?`,
      ok: 'Sí, conectar',
      cancel: 'Ahora no',
    });
    if (!ok) return false;
  }
  // Cómo estaba antes: si el calendario sigue en la misma dirección, no hay que suscribirse otra vez
  const prev = ctx.store.get().settings.sync;
  const prevUrl = prev.enabled && isConfigured(prev) ? webcalUrl(prev) : null;
  const prevWorked = Boolean(prevUrl && (prev.lastPushAt || prev.lastPullAt));

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
  if (t.readOnly && helper) {
    // Ya publica otro dispositivo (p. ej. el teléfono de esa persona): quien ayuda solo lee
  } else if (t.readOnly) {
    // Ya publica otro dispositivo (p. ej. el navegador de quien ayuda)
    const yes = await askUseThisDevice();
    if (yes) await becomePublisherNow(ctx);
  } else if (!t.error) {
    const b2 = busyDialog('Preparando tu calendario…');
    let r = null;
    try { r = await ctx.syncQueue.sync(); } finally { b2.close(); }
    if (r && r.ok && r.readOnly) {
      if (!helper && await askUseThisDevice()) await becomePublisherNow(ctx);
    } else if (r && !r.ok && r.error && !r.error.retry) {
      await alertDialog({ icon: '⚠️', title: 'Falta un detalle', text: r.error.message });
    }
  } else {
    // Sin internet: todavía no se sabe si otro dispositivo publica. Se preguntará al conectar.
    rememberAskTakeover(ctx.store.get().settings.sync);
  }
  if (helper) {
    ctx.go('ajustes', { section: 'github' });
    const label = ownLinkLabel(ctx.store.get());
    await alertDialog({
      icon: '✅',
      title: 'Conectado',
      text: `Ahora toca «${label}» y envía el enlace a la persona de este calendario (por ejemplo, por WhatsApp). En Android basta con abrirlo; en iPhone se pega en la app: Ajustes → «Tengo un enlace». Para otra persona de la familia, usa «Crear enlace para otra persona».`,
    });
    ctx.go('ajustes', { section: 'github' });
    return true;
  }
  ctx.go('ajustes', { section: 'calendar' });
  const url = webcalUrl(ctx.store.get().settings.sync);
  const same = url && ((prevWorked && url === prevUrl) || isSubscribed(ctx.store.get().settings.sync));
  if (same) ctx.toast('Listo, tu calendario sigue funcionando.', { type: 'ok', duration: 6000 });
  else openSubscribeSheet(ctx);
  return true;
}

function askUseThisDevice() {
  return confirmDialog({
    icon: '📲',
    title: `¿Usar este ${deviceWord()} para actualizar el calendario?`,
    text: `Ahora lo actualiza otro dispositivo (por ejemplo, el de quien te ayuda), que dejará de hacerlo. Primero se juntan los turnos de los dos. Recomendado si este es tu ${deviceWord()}.`,
    ok: 'Sí, usar este', cancel: 'No, solo leer',
  });
}

function rememberAskTakeover(sync) {
  try { safeStorage()?.setItem(ASK_TAKEOVER_KEY, JSON.stringify({ target: `${sync.owner}/${sync.repo}/${sync.branch || ''}`, at: new Date().toISOString() })); } catch { /* nada */ }
}

// Tras una sincronización (fondo): si se conectó sin internet y resulta que otro dispositivo publica,
// se pregunta ahora «¿Usar este iPhone?» (o «este teléfono»; una sola vez)
export async function maybeAskTakeover(ctx, res) {
  const ls = safeStorage();
  let pending = null;
  try { pending = JSON.parse(ls?.getItem(ASK_TAKEOVER_KEY) || 'null'); } catch { pending = null; }
  if (!pending || !res?.ok) return;
  const s = ctx.store.get().settings.sync;
  const drop = () => { try { ls?.removeItem(ASK_TAKEOVER_KEY); } catch { /* nada */ } };
  if (!s.enabled || pending.target !== `${s.owner}/${s.repo}/${s.branch || ''}` || !res.readOnly) { drop(); return; }
  if (sheetsOpen() || document.querySelector('.onboarding')) return; // se pregunta en la próxima
  drop();
  if (await askUseThisDevice()) await becomePublisherNow(ctx);
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
    text: 'Ahora lo actualiza otro dispositivo (por ejemplo, el de quien te ayuda), que dejará de hacerlo. Primero se juntan los turnos de los dos.',
    ok: 'Sí, usar este', cancel: 'Ahora no',
  });
  if (!ok) return false;
  return becomePublisherNow(ctx);
}

// Dirección que se toca para suscribirse: iPhone y ordenador webcal://; Android intent:// que abre
// ICSx⁵ (o su página de Google Play si no está instalada)
export function subscribeUrl(sync) {
  if (!sync?.owner || !sync?.repo) return null;
  const urls = calendarUrls(sync);
  return platform() === 'android' ? urls.android : urls.webcal;
}

// Botón grande «Suscribirme en el iPhone» / «Ver mis turnos en el calendario». Desactivado mientras se
// prepara el calendario. Al tocarlo se recuerda en este dispositivo (repetirlo duplicaría los turnos).
export function subscribeButton(ctx, sync, { block = true, secondary = false, onTap } = {}) {
  const url = subscribeUrl(sync);
  const ready = calendarReady(sync) && Boolean(url);
  return h('a', {
    class: ['btn', secondary ? 'btn-secondary' : 'btn-primary', 'btn-lg', block && 'btn-block', !ready && 'is-disabled'],
    href: ready ? url : '#', 'aria-disabled': ready ? 'false' : 'true', 'data-testid': 'webcal',
    on: { click: (e) => {
      if (ready) { markSubscribed(webcalUrl(sync), ctx.now()); onTap?.(); return; }
      e.preventDefault();
      ctx.toast('Espera un momento: estamos preparando tu calendario.', { type: 'info' });
    } },
  }, ready ? icon('calendar') : h('span', { class: ['spinner', 'spinner-sm', !secondary && 'spinner-white'], 'aria-hidden': 'true' }),
  ready ? subscribeLabel() : 'Preparando tu calendario…');
}

// «Suscrito ✓» + «¿Lo borraste del Calendario? Suscribirme otra vez» (con aviso de no repetirlo).
// En Android: «Abierto ✓» (al tocar se abre ICSx⁵ o Google Play: no se sabe si terminó)
export function subscribedBlock(ctx, sync, { onChange } = {}) {
  const info = subscribedInfo();
  const url = subscribeUrl(sync);
  const android = platform() === 'android';
  const cal = calendarName(ctx.store.get());
  const again = async () => {
    const ok = await confirmDialog({
      icon: '⚠️', title: android ? '¿Abrirlo otra vez?' : '¿Suscribirte otra vez?',
      text: android
        ? `Hazlo solo si no terminaste de suscribirte en ICSx⁵ o si borraste «${cal}». Si ya lo tienes, verías cada turno (y cada aviso) dos veces.`
        : `Hazlo solo si borraste el calendario «${cal}» de la app Calendario. Si todavía lo tienes, no lo repitas: verías cada turno (y cada aviso) dos veces.`,
      ok: android ? 'Abrir otra vez' : 'Lo borré: suscribirme', cancel: 'No, ya lo tengo',
      onOk: () => { markSubscribed(webcalUrl(sync), ctx.now()); openUrl(url); },
    });
    if (ok) onChange?.();
  };
  const since = info?.at ? ` · el ${dateTime(info.at).replace(/,.*$/, '')}` : '';
  return h('div', { class: 'subscribed', 'data-testid': 'subscribed' },
    h('p', { class: 'subscribed-line' }, h('span', {}, h('b', {}, android ? 'Abierto ✓' : 'Suscrito ✓'), android ? since : (info?.at ? ` · desde el ${dateTime(info.at).replace(/,.*$/, '')}` : ''))),
    h('p', { class: 'subscribed-hint' }, android
      ? 'Si ya ves tus turnos en el calendario, no hace falta repetirlo.'
      : 'Tus turnos ya llegan a la app Calendario. No hace falta repetirlo.'),
    h('button', { class: 'link-btn link-small', type: 'button', 'data-testid': 'subscribe-again', on: { click: again } },
      android ? '¿No terminaste? Abrirlo otra vez' : '¿Lo borraste del Calendario? Suscribirme otra vez'));
}

// Aviso que no puede faltar al suscribirse (para que el calendario avise)
export function alertsNotice() {
  const p = platform();
  if (p === 'desktop') return null;
  return h('div', { class: 'notice notice-warn notice-strong', 'data-testid': 'alerts-notice' }, icon('bell'), p === 'ios'
    ? h('p', {}, h('b', {}, 'Importante: '), `cuando el ${appleDevice()} lo pregunte, desactiva `, h('b', {}, '«Eliminar alertas»'), '. Si no, el calendario no te avisará.')
    : h('p', {}, h('b', {}, 'Importante: '), 'en ICSx⁵ deja ', h('b', {}, 'apagado'), ' «Ignore alerts embedded in the calendar». Si no, el calendario no te avisará.'));
}

export function subscribeSteps() {
  if (platform() === 'android') return icsx5ShortSteps({ buttonLabel: subscribeLabel() });
  return h('ol', { class: 'steps steps-compact' },
    h('li', {}, 'Toca ', h('b', {}, `«${subscribeLabel()}»`), '.'),
    h('li', {}, `El ${appleDevice()} pregunta si quieres suscribirte: toca `, h('b', {}, '«Suscribirse»'), '.'),
    h('li', {}, h('b', {}, 'Desactiva «Eliminar alertas»'), ' y toca ', h('b', {}, '«Agregar»'), ' (u «OK»).'));
}

// Sin internet mientras se prepara: que no parezca colgado
export function offlineHint(sync) {
  const offline = navigator.onLine === false || TRANSIENT.includes(sync?.lastErrorCode);
  if (calendarReady(sync) || !offline) return null;
  return h('p', { class: 'hint offline-hint', 'data-testid': 'offline-hint' }, icon('cloud'),
    h('span', {}, 'Sin conexión a internet: el botón se activará solo cuando vuelva. Puedes cerrar esto y volver luego a Ajustes.'));
}

// Último paso tras conectar: suscribirse en el calendario del teléfono (una sola vez)
export function openSubscribeSheet(ctx) {
  const plat = platform();
  const body = h('div', { class: 'subscribe-body', 'data-testid': 'subscribe-step' });
  const foot = h('div', { class: 'subscribe-btn-host' });
  let sheet = null;
  const moved = (() => { const old = subscribedInfo(); return Boolean(old && old.url !== webcalUrl(ctx.store.get().settings.sync)); })();
  const cal = calendarName(ctx.store.get());
  const guides = () => (plat === 'ios' ? null : androidGuides(ctx, { calName: cal, buttonLabel: subscribeLabel(), open: plat === 'desktop' }));
  const paint = () => {
    const s = ctx.store.get().settings.sync;
    const ready = calendarReady(s);
    const copy = plat !== 'ios' && ready ? copyLinkButton(ctx, calendarUrls(s).https) : null;
    if (isSubscribed(s) && plat !== 'desktop') {
      setChildren(body,
        h('div', { class: 'notice notice-ok', 'data-testid': 'subscribe-done' }, icon('check'), h('p', {},
          h('b', {}, 'Hecho. '), plat === 'ios'
            ? `Si el ${appleDevice()} te lo preguntó, la suscripción ya quedó hecha: tus turnos aparecen en la app Calendario en unos minutos.`
            : 'Si se abrió ICSx⁵, termina allí: «SUBSCRIBE» y, en la pantalla siguiente, la flecha → (arriba). Después abre ICSx⁵ desde su icono: menú ⋮ → «Marcar intervalo de sincronización» → «Cada hora». Si se abrió Google Play, instala ICSx⁵ y vuelve a tocar el botón en Ajustes.')),
        alertsNotice(),
        plat === 'ios'
          ? h('p', { class: 'hint' }, 'No hace falta repetirlo. Si no se abrió nada, en Ajustes → «¿No se abre o no se actualiza?» está la forma a mano.')
          : guides());
      setChildren(foot, h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'subscribe-close', on: { click: () => sheet?.close() } }, 'Listo'));
      return;
    }
    setChildren(body,
      moved ? h('div', { class: 'notice notice-info' }, icon('info'), h('p', {},
        h('b', {}, 'Tu calendario tiene una dirección nueva. '),
        plat === 'android'
          ? `Suscríbete a la nueva y, en ICSx⁵, borra la suscripción antigua de «${cal}» para no ver los turnos dos veces.`
          : `Suscríbete a la nueva y, en la app Calendario, borra el «${cal}» antiguo para no ver los turnos dos veces.`)) : null,
      plat === 'desktop' ? h('p', { class: 'hint' }, 'Copia el enlace del calendario y agrégalo en el calendario que uses (por ejemplo, Google Calendar «Desde una URL»). En un iPhone o un Android, hazlo desde la app Turnos del teléfono.') : null,
      alertsNotice(),
      plat === 'desktop' ? null : subscribeSteps(),
      plat === 'ios' ? h('p', { class: 'hint' }, 'Hazlo una sola vez. Tus turnos aparecen en la app Calendario en unos minutos.') : guides());
    setChildren(foot, plat === 'desktop' ? copy : subscribeButton(ctx, s, { onTap: () => setTimeout(paint, 400) }),
      plat === 'desktop' ? null : copy, offlineHint(s));
  };
  paint();
  const unsub = ctx.store.subscribe(paint);
  const onNet = () => paint();
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);
  sheet = openSheet({
    title: 'Último paso: tu calendario',
    subtitle: `Así el ${deviceWord()} te avisa antes de cada turno`,
    className: 'sheet-subscribe',
    body,
    footer: foot,
    onClose: () => {
      unsub();
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
      ctx.repaint?.(); // Ajustes pasa a «Suscrito ✓»
    },
  });
  return sheet;
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
