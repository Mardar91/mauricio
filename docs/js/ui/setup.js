// Conectar el calendario del teléfono: enlace de configuración (#setup=…), «Tengo un enlace» (pegar),
// último paso para suscribirse (iPhone: webcal; Android: ICSx⁵) y «Usar este dispositivo». Todo pasa
// por la cola única (ctx.syncQueue).
import {
  calendarName, calendarUrls, dataTargetOf, firstNameKey, isReadOnlyDevice, listBeforeImport, parseSetupLink, publicName,
  saveBeforeImport, syncTargetId, undoImport, updateSettings,
} from '../core/index.js';
import { copyText, dateTime, h, plural, safeStorage, setChildren } from './dom.js';
import { icon } from './icons.js';
import { installSteps } from './install.js';
import { inSafariTab, savedToast } from './banners.js';
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
// helper: se conecta desde «Opciones avanzadas» (normalmente quien ayuda): no pide suscribirse ni
// «¿Usar este dispositivo?» y lleva a «Crear enlace…». En un repo vacío este dispositivo publica primero
// (rev 1, sin turnos); el teléfono de la persona toma el relevo al abrir el enlace («¿Usar este iPhone?»).
export async function runSetup(ctx, cfg, { confirm = true, helper = false } = {}) {
  // Si ya se sabe que viene una pregunta de cambio de calendario (o «¿Estos turnos son de…?»), sobra el
  // «Conectar…» genérico (que además diría «tus turnos»)
  if (confirm && !questionAhead(ctx.store.get(), cfg)) {
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
  // De quién es este dispositivo (su nombre antes de conectar)
  let prevName = publicName(ctx.store.get().settings.name || '');

  let t = await checkSetup(ctx, cfg);
  let switched = null;
  // Turnos sin nombre y el calendario es de alguien: preguntar de quién son antes de juntar nada
  if (!t.ok && t.error?.code === 'OTHER_PERSON' && t.otherPerson?.unnamed) {
    const own = await confirmOwnDays(ctx, cfg, t);
    if (!own) return false;
    t = own.t;
    switched = own.switched || null;
    if (own.named) prevName = own.named;
  }
  // Calendario de otra persona (u otro destino): preguntar antes de cambiar este dispositivo
  if (!switched && !t.ok && SWITCH_CODES.includes(t.error?.code)) {
    switched = await confirmSwitch(ctx, cfg, t);
    if (!switched) return false;
    t = switched.t;
  }
  if (!t.ok) {
    await alertDialog({ icon: '⚠️', title: 'No se pudo conectar', text: failText(t.error, { link: confirm, helper }) });
    return false;
  }
  // De quién es el calendario conectado (tras cambiar, el estado limpio ya tomó su nombre)
  const calWho = publicName(t.res?.remote?.name || '') || publicName(switched?.otherPerson?.name || '') || publicName(cfg?.name || '')
    || (switched ? publicName(ctx.store.get().settings.name || '') : '');
  const samePerson = Boolean(prevName && calWho && firstNameKey(prevName) === firstNameKey(calWho));
  const otherPerson = Boolean(prevName && calWho && !samePerson);
  // Tras cambiar de calendario: «Deshacer» al final (que no lo tapen los diálogos de abajo). Con el paso
  // «Suscribirme» abierto va dentro de la hoja (un aviso abajo taparía su botón de cerrar).
  const undoSwitch = switched?.key ? () => {
    const msg = restoreCopy(ctx, switched.key);
    if (!msg) return;
    // Si tomó el relevo, ese calendario aún dice que lo actualiza este dispositivo
    savedToast(ctx, switched.tookOver
      ? `${msg} El calendario al que habías cambiado ya no se actualiza desde aquí: en el dispositivo que lo usa, toca «Usar este dispositivo».` : msg,
    switched.tookOver ? { duration: 12000 } : undefined);
  } : null;
  const undoToast = () => {
    if (!undoSwitch) return;
    const name = publicName(ctx.store.get().settings.name || '');
    ctx.toast(name ? `Este ${deviceWord()} usa ahora el calendario de ${name}.` : `Este ${deviceWord()} usa ahora otro calendario.`, {
      type: 'ok', duration: 12000, action: { label: 'Deshacer', run: undoSwitch },
    });
  };
  // Tomar el relevo: tras cambiar de calendario, solo si es el de la misma persona (si no, este
  // dispositivo solo lee: el calendario de otra persona nunca pasa a publicarse desde aquí sin más).
  // Sin cambiar, se pregunta nombrando el calendario, y no se recomienda si es de otra persona.
  const offerTakeover = switched ? samePerson : true;
  const takeoverAsk = () => askUseThisDevice({ who: calWho, recommended: !otherPerson });
  const takeover = async () => {
    const ok = await becomePublisherNow(ctx);
    if (ok && switched) switched.tookOver = true;
  };
  let waiting = false; // quien ayuda, sin internet: el enlace se podrá crear cuando conecte
  if (t.readOnly && helper) {
    // Ya publica otro dispositivo (p. ej. el teléfono de esa persona): quien ayuda solo lee
  } else if (t.readOnly) {
    // Ya publica otro dispositivo (p. ej. el navegador de quien ayuda)
    if (offerTakeover && await takeoverAsk()) await takeover();
  } else if (!t.error) {
    const b2 = busyDialog('Preparando tu calendario…');
    let r = null;
    try { r = await ctx.syncQueue.sync(); } finally { b2.close(); }
    if (r && r.ok && r.readOnly) {
      if (!helper && offerTakeover && await takeoverAsk()) await takeover();
    } else if (r && !r.ok && r.error && !r.error.retry) {
      await alertDialog({ icon: '⚠️', title: 'Falta un detalle', text: failText(r.error, { helper, sent: true }) });
      // Quien ayuda no puede crear el enlace con este error: no se dice «Conectado»
      if (helper) { undoToast(); return false; }
    } else if (r && !r.ok && helper) {
      waiting = true;
    }
  } else if (helper) {
    // Sin internet: quien ayuda nunca toma el relevo (no se pregunta luego «¿Usar este dispositivo?»)
    waiting = true;
  } else if (offerTakeover) {
    // Sin internet: todavía no se sabe si otro dispositivo publica. Se preguntará al conectar.
    rememberAskTakeover(ctx.store.get().settings.sync, { who: calWho, recommended: !otherPerson });
  }
  if (helper) {
    ctx.go('ajustes', { section: 'github' });
    const label = ownLinkLabel(ctx.store.get());
    await alertDialog(waiting ? {
      icon: '☁️',
      title: 'Guardado, sin conexión',
      text: `Se conectará cuando haya internet; luego podrás crear el enlace («${label}»).`,
    } : {
      icon: '✅',
      title: 'Conectado',
      text: `Ahora toca «${label}» y envía el enlace a la persona de este calendario (por ejemplo, por WhatsApp). En Android basta con abrirlo; en iPhone se pega en la app: Ajustes → «Tengo un enlace». Para otra persona de la familia, usa «Crear enlace para otra persona».`,
    });
    ctx.go('ajustes', { section: 'github' });
    undoToast();
    return true;
  }
  ctx.go('ajustes', { section: 'calendar' });
  const url = webcalUrl(ctx.store.get().settings.sync);
  const same = url && ((prevWorked && url === prevUrl) || isSubscribed(ctx.store.get().settings.sync));
  if (same) {
    if (undoSwitch) undoToast();
    else ctx.toast('Listo, tu calendario sigue funcionando.', { type: 'ok', duration: 6000 });
  } else {
    openSubscribeSheet(ctx, { switchedFrom: switched ? (prevName || null) : undefined, onUndo: undoSwitch });
  }
  return true;
}

// ¿Va a preguntar la comprobación (cambio de calendario o «¿Estos turnos son de…?»)? Sí, si los datos
// de aquí son de otro destino, o si hay turnos sin destino y el enlace es de otro nombre (o aquí no hay)
function questionAhead(state, cfg) {
  const s = state?.settings?.sync || {};
  const bound = dataTargetOf(s);
  if (bound) return bound !== syncTargetId({ ...cfg, dir: cfg?.dir ?? s.dir });
  const days = Object.keys(state?.days || {}).length;
  const mine = publicName(state?.settings?.name || ''), theirs = publicName(cfg?.name || '');
  return Boolean(days && theirs && (!mine || firstNameKey(mine) !== firstNameKey(theirs)));
}

// Texto de «No se pudo conectar» / «Falta un detalle». link: vino de un enlace (si no, del formulario);
// sent: el error salió al sincronizar (ya conectado), no al comprobar
function failText(error, { link = false, helper = false, sent = false } = {}) {
  const msg = error?.message || 'No se pudo conectar.';
  if (!sent && error?.code === 'NETWORK') {
    return `Sin conexión a internet: no se cambió nada. ${link ? 'Abre el enlace otra vez' : 'Inténtalo otra vez'} cuando tengas internet.`;
  }
  if (!sent && error?.retry) return 'El calendario no responde en este momento: no se cambió nada. Inténtalo otra vez en un rato.';
  // Quien ayuda es «quien te configuró la app»: cómo volver a un calendario cuya clave no tiene aquí
  if (helper && (error?.code === 'NO_KEY' || error?.code === 'DECRYPT')) {
    const base = msg.replace(/\s*Pide ayuda a quien te configuró la app\.?\s*$/, '');
    return `${base} ${hasSwitchCopy()
      ? 'Para volver a un calendario que ya usabas aquí: Opciones avanzadas → Restaurar → «Copia de antes de cambiar de calendario», o abre aquí el enlace del teléfono que lo publica.'
      : 'Abre aquí el enlace del teléfono que publica ese calendario (lleva su clave), o crea el enlace desde ese teléfono.'}`;
  }
  return msg;
}

// ¿Hay alguna copia guardada al cambiar de calendario? (Restaurar la ofrece)
function hasSwitchCopy() {
  try {
    return listBeforeImport(safeStorage()).some((c) => copyInfo(null, c.key)?.switch);
  } catch {
    return false;
  }
}

// «¿Estos turnos son de Ana?»: aquí hay turnos sin nombre que nunca se conectaron y el enlace es del
// calendario de alguien (CORE-API §3.7, otherPerson.unnamed).
//  - Sí → este dispositivo es de esa persona: se pone su nombre y se conecta como siempre (se juntan).
//  - No → cambiar a ese calendario desde cero (los de ahora se guardan como copia) o cancelar.
// → null (cancelado: nada cambió) | { t, named } | { t, switched }
async function confirmOwnDays(ctx, cfg, t) {
  const who = publicName(t.otherPerson.name || '');
  const dev = deviceWord();
  const n = Object.keys(ctx.store.get().days || {}).length;
  const yes = await confirmDialog({
    icon: '👤',
    title: `¿Estos turnos son de ${who}?`,
    text: `En este ${dev} hay ${plural(n, 'día', 'días')} con turnos y no dice de quién son. El enlace es del calendario de ${who}: si son de ${who}, se juntan con su calendario. Si son de otra persona, toca «No» y no se junta nada.`,
    ok: `Sí, son de ${who}`, cancel: 'No',
  });
  if (yes) {
    const before = ctx.store.get().settings.name || '';
    ctx.store.set((s) => updateSettings(s, { name: who }));
    const t2 = await checkSetup(ctx, cfg);
    // No se conectó: el nombre vuelve a como estaba («No se cambió nada»)
    if (!t2.ok && ctx.store.get().settings.name === who) ctx.store.set((s) => updateSettings(s, { name: before }));
    return { t: t2, named: who };
  }
  const sw = await confirmSwitch(ctx, cfg, t, {
    title: `¿Cambiar este ${dev} al calendario de ${who}?`,
    text: `Entonces los turnos de aquí no se juntan con los de ${who}. Puedes cambiar este ${dev} a su calendario: los turnos de ahora no pasan a ese calendario, se guardan como copia y puedes deshacerlo. Si el enlace no era para ti, toca «Cancelar» y pide el correcto.`,
  });
  return sw ? { t: sw.t, switched: sw } : null;
}

// Códigos del core para «esto es de otro calendario» (CORE-API §3.7)
const SWITCH_CODES = ['OTHER_PERSON', 'OTHER_TARGET'];

// Comprobar con la cola (lee y descifra con una copia: si falla, nada cambia)
async function checkSetup(ctx, cfg, opts) {
  const busy = busyDialog(opts?.switchPerson ? 'Cambiando de calendario…' : 'Conectando con tu calendario…');
  try {
    return await (opts ? ctx.syncQueue.setup(cfg, opts) : ctx.syncQueue.setup(cfg));
  } catch (e) {
    return { ok: false, error: { message: e?.message || 'No se pudo conectar.' } };
  } finally {
    busy.close();
  }
}

// Texto de la pregunta: el mensaje del core (de quién es cada calendario) + qué pasa al cambiar
export function switchQuestion(message) {
  const base = String(message || '').replace(/\s*No se cambió nada\.?\s*$/, '').trim();
  if (/¿/.test(base)) return base; // el core ya pregunta
  return `${base ? `${base} ` : ''}¿Cambiar este dispositivo a ese calendario? Los turnos de ahora no pasan a ese calendario: se guardan como copia y puedes deshacerlo.`;
}

// «¿Cambiar este dispositivo a ese calendario?» → copia para deshacer → setup({ switchPerson: true }).
// ask: { title, text } para otra pregunta. → null (cancelado) | { t, key, otherPerson, tookOver }
async function confirmSwitch(ctx, cfg, t, ask = null) {
  // Nombre del otro calendario (solo si no es el mismo nombre que el de ahora: otra carpeta del mismo)
  const theirs = publicName(t.otherPerson?.name || cfg?.name || '');
  const mine = publicName(t.otherPerson?.current?.name || ctx.store.get().settings.name || '');
  const who = theirs && theirs.toLowerCase() !== mine.toLowerCase() ? theirs : '';
  const ok = await confirmDialog({
    icon: '👤',
    title: ask?.title || (who ? `¿Cambiar al calendario de ${who}?` : '¿Cambiar de calendario?'),
    text: ask?.text || switchQuestion(t.error?.message),
    ok: 'Sí, cambiar', cancel: 'Cancelar',
  });
  if (!ok) return null;
  const ls = safeStorage();
  // personSwitch: marca la copia como «de otro calendario» (al recuperarla se vuelve a él entero)
  const key = saveBeforeImport({ ...ctx.store.get(), personSwitch: { at: ctx.now().toISOString() } }, ls, { now: ctx.now() });
  if (!key && !(await confirmDialog({
    icon: '⚠️', title: 'No se podrá deshacer', danger: true,
    text: 'No hay espacio para guardar una copia de lo de ahora: no se podrá deshacer. ¿Cambiar igualmente?',
    ok: 'Cambiar', cancel: 'Cancelar',
  }))) return null;
  const t2 = await checkSetup(ctx, cfg, { switchPerson: true });
  // No se cambió nada: la copia sobra
  if (!t2.ok && key) { try { ls?.removeItem(key); } catch { /* nada */ } }
  return { t: t2, key: t2.ok ? key : null, otherPerson: t.otherPerson || null, tookOver: false };
}

// Calendario del que son los datos de un estado (como el core: el de sus datos o, si no, el conectado)
function placeOf(sync) {
  return dataTargetOf(sync) || (sync?.enabled && String(sync.token || '').trim() ? syncTargetId(sync) : '');
}

// Una copia guardada antes de importar, de borrar o de cambiar de calendario
// → { otherTarget, switch, name, connected } | null. otherTarget: es de otro calendario (otra persona u
// otro destino): al recuperarla se vuelve a él entero; switch: se guardó al cambiar de calendario;
// connected: era de un calendario (si no, el dispositivo vuelve a estar sin conectar)
export function copyInfo(state, key) {
  let raw = null;
  try { raw = JSON.parse(safeStorage()?.getItem(key) || 'null'); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return null;
  const place = placeOf(raw.settings?.sync);
  const otherTarget = place !== placeOf(state?.settings?.sync);
  return { otherTarget, switch: Boolean(raw.personSwitch), name: publicName(raw.settings?.name || '') || null, connected: Boolean(place) };
}

// Volver a una copia (deshacer una importación o un cambio de calendario) con undoImport: si la copia es
// de otro calendario, vuelve el estado anterior entero (con su conexión): sus turnos nunca se importan en
// el de ahora (CORE-API §3.7). → texto para el aviso «Listo…» | null (la copia ya no existe)
export function restoreCopy(ctx, key) {
  const info = copyInfo(ctx.store.get(), key);
  const prev = undoImport(safeStorage(), ctx.store.get(), { now: new Date(), key });
  if (!prev) return null;
  ctx.store.set(() => prev);
  return info?.otherTarget && info.name && prev.settings.sync.enabled
    ? `Listo: este ${deviceWord()} vuelve al calendario de ${info.name}.` : 'Listo: todo está como antes.';
}

// «¿Usar este iPhone para actualizar el calendario de Ana?». who: de quién es el calendario ('' = no se
// sabe); recommended: false si este dispositivo es de otra persona («No, solo leer» va primero)
function askUseThisDevice({ who = '', recommended = true } = {}) {
  const dev = deviceWord();
  return confirmDialog({
    icon: '📲',
    title: who ? `¿Usar este ${dev} para actualizar el calendario de ${who}?` : `¿Usar este ${dev} para actualizar el calendario?`,
    text: who
      ? `Ahora lo actualiza otro dispositivo (el de ${who} o el de quien te ayuda), que dejará de hacerlo. Primero se juntan los turnos de los dos. Hazlo solo si este es el ${dev} de ${who}.`
      : `Ahora lo actualiza otro dispositivo (por ejemplo, el de quien te ayuda), que dejará de hacerlo. Primero se juntan los turnos de los dos. Recomendado si este es tu ${dev}.`,
    ok: 'Sí, usar este', cancel: 'No, solo leer',
    prefer: recommended ? 'ok' : 'cancel',
  });
}

function rememberAskTakeover(sync, { who = '', recommended = true } = {}) {
  try {
    safeStorage()?.setItem(ASK_TAKEOVER_KEY, JSON.stringify({
      target: `${sync.owner}/${sync.repo}/${sync.branch || ''}`, dir: String(sync.dir || ''), who, recommended, at: new Date().toISOString(),
    }));
  } catch { /* nada */ }
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
  if (!s.enabled || pending.target !== `${s.owner}/${s.repo}/${s.branch || ''}` || (pending.dir ?? String(s.dir || '')) !== String(s.dir || '') || !res.readOnly) { drop(); return; }
  if (sheetsOpen() || document.querySelector('.onboarding')) return; // se pregunta en la próxima
  drop();
  // Ahora se sabe de quién es el calendario (meta.name de la copia): si es de otra persona, no se recomienda
  const who = publicName(res.remote?.name || '') || publicName(pending.who || '');
  const mine = publicName(ctx.store.get().settings.name || '');
  const other = Boolean(who && mine && firstNameKey(who) !== firstNameKey(mine));
  if (await askUseThisDevice({ who, recommended: pending.recommended !== false && !other })) await becomePublisherNow(ctx);
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

// «Usar este dispositivo» (Ajustes): nombra el calendario si se sabe de quién es
export async function takeOver(ctx) {
  const who = publicName(ctx.store.get().settings.name || '');
  const dev = deviceWord();
  const ok = await confirmDialog({
    icon: '📲',
    title: who ? `¿Actualizar el calendario de ${who} desde este ${dev}?` : '¿Actualizar el calendario desde este dispositivo?',
    text: who
      ? `Ahora lo actualiza otro dispositivo (el de ${who} o el de quien te ayuda), que dejará de hacerlo. Primero se juntan los turnos de los dos. Hazlo solo si este es el ${dev} de ${who}.`
      : 'Ahora lo actualiza otro dispositivo (por ejemplo, el de quien te ayuda), que dejará de hacerlo. Primero se juntan los turnos de los dos.',
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

// Último paso tras conectar: suscribirse en el calendario del teléfono (una sola vez).
// switchedFrom: tras cambiar de calendario (otra persona), el nombre del anterior (o null); onUndo:
// «Deshacer el cambio» (vuelve al calendario anterior)
export function openSubscribeSheet(ctx, { switchedFrom, onUndo } = {}) {
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
    const switchedNote = switchedFrom !== undefined ? h('div', { class: 'notice notice-info', 'data-testid': 'switched-note' }, icon('info'), h('p', {},
      h('b', {}, `Este ${deviceWord()} usa ahora «${cal}». `),
      isReadOnlyDevice(s) ? 'Solo lee: ese calendario lo sigue actualizando otro dispositivo. ' : null,
      switchedFrom
        ? `Si antes te suscribiste al de ${switchedFrom}, puedes dejarlo (son sus turnos) o borrarlo del calendario.`
        : 'Si antes te suscribiste a otro calendario, puedes dejarlo o borrarlo del calendario.',
      onUndo ? h('button', {
        class: 'link-btn link-small switched-undo', type: 'button', 'data-testid': 'switch-undo',
        on: { click: () => { sheet?.close(); onUndo(); } },
      }, switchedFrom ? `Deshacer: volver al calendario de ${switchedFrom}` : 'Deshacer el cambio') : null)) : null;
    setChildren(body,
      switchedNote,
      moved && !switchedNote ? h('div', { class: 'notice notice-info' }, icon('info'), h('p', {},
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
