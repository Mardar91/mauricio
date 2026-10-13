// Pestaña "Ajustes" (SPEC §10): 1) Calendario del iPhone, 2) Mis turnos y horarios, 3) Horas de contrato
// y Recordatorios, 4) Copia de seguridad, 5) Instalar, 6) Opciones avanzadas (plegadas), 7) Acerca de.
import {
  UNKNOWN_PUBLISHER, addDays, buildICS, buildSetupLink, calendarUrls, createDefaultState, exportBackup, fetchRemoteBackup,
  formatHours, generateSyncKey, hasTime, importBackup, isReadOnlyDevice, isSyncKey, listBeforeImport, normalizeSyncConfig,
  randomTopic, saveBeforeImport, testConnection, testNtfy, toKey, undoImport, updateSettings,
} from '../core/index.js';
import { badgeFromDef, displayName, groupCodes, timeRange } from './badge.js';
import {
  copyText, dateTime, fmtNum, h, isStandalone, minutesText, parseNum, plural, safeStorage, setChildren, shareOrDownload,
} from './dom.js';
import { icon } from './icons.js';
import { confirmDialog } from './sheet.js';
import { unconfirmedInUse } from './attention.js';
import { showOnboarding } from './onboarding.js';
import {
  alertsNotice, openPasteSetup, runSetup, subscribeButton, subscribeSteps, subscribedBlock, takeOver,
} from './setup.js';
import { banners, inSafariTab, saveFailedToast, savedToast } from './banners.js';
import { installSteps, openInstallSheet } from './install.js';
import { calendarReady, isConfigured, isSubscribed, markSubscribed, syncState, webcalUrl } from './syncStatus.js';
import { DRAFT_KEY } from './scan.js';

const MINUTES = [15, 30, 45, 60, 90, 120];
const CORE_SHIFTS = ['F1', 'S1', 'N1', 'Z1'];
const SOON_DAYS = 60; // «Mis turnos»: los turnos que se usan en los próximos ~2 meses

export function createSettings(ctx) {
  const { store } = ctx;
  const ls = safeStorage();
  const el = h('section', { 'aria-label': 'Ajustes' });
  const busy = {}; // botones en curso
  let showToken = false;
  let showAllCodes = false;
  let form = null; // conexión con GitHub mientras se escribe (no se guarda hasta «Guardar y conectar»)

  const set = (patch) => store.set((s) => updateSettings(s, patch));

  // ---------- Piezas ----------
  const group = (title, rows, { footer, id, cls } = {}) => h('section', { class: ['set-group', cls], id },
    title ? h('h2', { class: 'set-title' }, title) : null,
    h('div', { class: 'card set-card' }, rows),
    footer ? h('p', { class: 'set-footer' }, footer) : null);

  const row = (label, control, { sub, icon: ic, cls, tag = 'div' } = {}) => h(tag, { class: ['set-row', cls] },
    ic ? h('span', { class: ['set-icon', `si-${ic}`], 'aria-hidden': 'true' }, icon(ic)) : null,
    h('span', { class: 'set-row-main' }, h('span', { class: 'set-label' }, label), sub ? h('span', { class: 'set-sub' }, sub) : null),
    control);

  // Fila con interruptor: toda la fila (label) lo activa
  const switchRow = (label, fkey, checked, onChange, opts = {}) => row(label,
    h('input', { type: 'checkbox', class: 'switch', checked, dataset: { fkey }, on: { change: (e) => onChange(e.target.checked) } }),
    { ...opts, tag: 'label', cls: ['set-row-switch', opts.cls].filter(Boolean).join(' ') });

  function actionButton(id, label, ic, run, cls = 'btn-secondary') {
    return h('button', {
      class: ['btn', cls, busy[id] && 'is-busy'], type: 'button', disabled: Boolean(busy[id]), dataset: { fkey: `btn-${id}` },
      on: { click: async () => {
        busy[id] = true; refresh();
        try { await run(); } catch (e) { console.error(e); ctx.toast(e?.message || 'Algo falló.', { type: 'error' }); } finally { busy[id] = false; refresh(); }
      } },
    }, busy[id] ? h('span', { class: 'spinner spinner-sm' }) : (ic ? icon(ic) : null), label);
  }

  // Re-pinta conservando el foco del botón pulsado (lectores de pantalla) y lo desplegado
  function refresh() {
    const fkey = el.contains(document.activeElement) ? document.activeElement.dataset.fkey : null;
    const open = new Set([...el.querySelectorAll('details[open]')].map((d) => d.dataset.fkey));
    render(store.get());
    for (const d of el.querySelectorAll('details[data-fkey]')) if (open.has(d.dataset.fkey)) d.open = true;
    if (fkey) el.querySelector(`[data-fkey="${CSS.escape(fkey)}"]`)?.focus({ preventScroll: true });
  }

  const details = (fkey, summary, ...content) => h('details', { class: 'guide', dataset: { fkey } },
    h('summary', {}, h('span', {}, summary), icon('chevronDown', 'icon chev')), h('div', { class: 'guide-body' }, content));

  const steps = (...items) => h('ol', { class: 'steps' }, items.map((it) => h('li', {}, it)));

  // ---------- 1. Calendario del iPhone ----------
  function calendar(state) {
    const s = state.settings.sync;
    const st = syncState(state, ctx.now(), { busy: ctx.background?.busy?.() });
    const configured = s.enabled && isConfigured(s);
    const statusIcon = { off: 'calendar', ok: 'check', busy: 'refresh', pending: 'refresh', transient: 'cloud', readonly: 'phone', error: 'warning' }[st.kind];
    const urls = configured ? calendarUrls(s) : null;

    const status = h('div', { class: ['cal-status', `cal-${st.kind}`], 'data-testid': 'sync-status', dataset: { kind: st.kind } },
      h('span', { class: 'cal-status-icon', 'aria-hidden': 'true' }, st.kind === 'busy' ? h('span', { class: 'spinner spinner-sm' }) : icon(statusIcon)),
      h('span', { class: 'cal-status-main' },
        h('span', { class: 'cal-status-title' }, st.title),
        st.text ? h('span', { class: 'cal-status-text' }, st.text) : null));

    const blocks = [status];
    const linkBtn = (primary) => h('button', {
      class: primary ? 'btn btn-primary btn-block' : 'link-btn link-center', type: 'button',
      'data-testid': primary ? 'setup-paste-open' : 'setup-paste-renew', on: { click: () => openPasteSetup(ctx, { renew: true }) },
    }, primary ? icon('link') : null, 'Tengo un enlace nuevo');
    // Suscripción: «Suscrito ✓» si ya se hizo en este dispositivo; si no, el botón (secundario si hay error)
    const subscription = (secondary) => (isSubscribed(s)
      ? subscribedBlock(ctx, s, { onChange: refresh })
      : [
        secondary ? null : alertsNotice(),
        subscribeButton(ctx, s, { secondary, onTap: () => setTimeout(refresh, 400) }),
        secondary ? null : subscribeSteps(),
        // Quien se suscribió con una versión anterior (sin recordarlo): para no invitar a repetirlo
        calendarReady(s) ? h('button', {
          class: 'link-btn link-center link-small', type: 'button', 'data-testid': 'already-subscribed',
          on: { click: () => { markSubscribed(webcalUrl(s), ctx.now()); refresh(); } },
        }, 'Ya me suscribí antes') : null,
      ]);

    if (!configured) {
      if (inSafariTab()) {
        // En Safari el enlace no sirve (se guardaría aquí, no en la app): primero instalar
        blocks.push(h('div', { class: 'set-actions' },
          h('p', { class: 'set-hint' }, 'Primero pon la app en tu pantalla de inicio. El enlace que te envíen se pega dentro de la app, no aquí en Safari.'),
          h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'cal-install', on: { click: () => openInstallSheet(ctx) } }, icon('phone'), 'Primero instala la app')));
      } else {
        blocks.push(h('div', { class: 'set-actions' },
          h('p', { class: 'set-hint' }, 'Quien te ayuda con la app te envía un enlace de configuración (por WhatsApp o correo). Cuando lo tengas, toca aquí:'),
          h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'setup-paste-open', on: { click: () => openPasteSetup(ctx) } }, icon('link'), 'Tengo un enlace')));
      }
    } else if (st.kind === 'error') {
      // Una sola acción principal, la que arregla este error
      let fix;
      if (st.remedy === 'update') {
        fix = h('button', { class: 'btn btn-primary btn-block', type: 'button', 'data-testid': 'update-app', on: { click: () => ctx.updateApp?.() } }, icon('refresh'), 'Actualizar la app');
      } else if (st.remedy === 'pull') {
        fix = actionButton('pullfix', 'Traer mis turnos de internet', 'cloud', async () => {
          const r = await ctx.syncQueue.pull();
          if (r.ok) savedToast(ctx, r.pulledDays?.length ? `Listo: llegaron ${plural(r.pulledDays.length, 'día', 'días')}.` : 'Listo.');
          else ctx.toast(r.error.message, { type: 'error', duration: 7000 });
        }, 'btn-primary btn-block');
      } else {
        fix = linkBtn(true);
      }
      // Suscribirse queda en segundo plano (y solo si el calendario ya existe)
      blocks.push(h('div', { class: 'set-actions set-subscribe' }, fix, calendarReady(s) || isSubscribed(s) ? subscription(true) : null));
    } else {
      blocks.push(h('div', { class: 'set-actions set-subscribe' },
        st.kind === 'readonly' ? h('button', { class: 'btn btn-secondary btn-block', type: 'button', 'data-testid': 'takeover', on: { click: () => takeOver(ctx) } }, icon('phone'), 'Usar este dispositivo') : null,
        subscription(false),
        linkBtn(false)));
    }
    return h('section', { class: 'set-group', id: 'set-calendar' },
      h('h2', { class: 'set-title' }, 'Calendario del iPhone'),
      h('div', { class: 'card set-card cal-card' }, blocks),
      configured ? details('guide-cal', '¿No se abre o no se actualiza?',
        h('p', { class: 'hint' }, 'Si al tocar «Suscribirme en el iPhone» no pasa nada, hazlo a mano: abre ', h('b', {}, 'Ajustes'),
          ' del iPhone (en algunos se llama «Configuración») → Calendario → Cuentas → «Agregar cuenta» (o «Añadir cuenta») → Otra → «Agregar calendario suscrito», y pega este enlace:'),
        urls ? h('div', { class: 'copy-line' },
          h('code', {}, urls.https),
          h('button', { class: 'btn btn-tinted btn-sm', type: 'button', on: { click: async () => { const ok = await copyText(urls.https); ctx.toast(ok ? 'Enlace copiado' : 'No se pudo copiar', { type: ok ? 'ok' : 'error' }); } } }, icon('copy'), 'Copiar')) : null,
        h('p', { class: 'hint' }, 'En iOS 18 el camino es: Ajustes → Apps → Calendario → Cuentas de calendario.'),
        h('p', { class: 'hint' }, h('b', {}, 'Para que se actualice más a menudo: '), 'Ajustes → Calendario → Cuentas → «Obtener datos» → en «Calendarios suscritos» elige «Cada 15 minutos» o «Cada hora».'),
        h('p', { class: 'hint' }, 'Si cambias un turno de mañana, abre un momento la app Calendario para que lo recoja.')) : null);
  }

  // ---------- 2. Mis turnos y horarios ----------
  function codes(state) {
    const now = ctx.now();
    const today = toKey(now), until = addDays(today, SOON_DAYS);
    const unconf = unconfirmedInUse(state, now);
    const used = new Set(), soon = new Set();
    for (const [k, d] of Object.entries(state.days || {})) {
      for (const c of Array.isArray(d?.codes) ? d.codes : []) { used.add(c); if (k >= today && k <= until) soon.add(c); }
    }
    const all = groupCodes(state).flatMap((g) => g.codes);
    const timedKind = (d) => ['shift', 'event', 'other'].includes(d.kind);
    // A la vista: F1/S1/N1/Z1, los turnos de los próximos ~2 meses y los que hay que confirmar.
    // Los lugares usados, juntos en «Lugares (N)»; el resto, en «Ver todos los códigos».
    const primary = all.filter((d) => d.kind !== 'place'
      && (CORE_SHIFTS.includes(d.code) || (timedKind(d) && soon.has(d.code)) || unconf.get(d.code)?.next));
    const places = all.filter((d) => d.kind === 'place' && used.has(d.code));
    const rest = all.filter((d) => !primary.includes(d) && !places.includes(d));

    const codeRow = (def) => {
      const u = unconf.get(def.code); // sin confirmar y usado
      const isPlace = def.kind === 'place';
      const sub = isPlace
        ? (def.place || 'Sin dirección')
        : [timeRange(def), def.breakMin && hasTime(def) ? `pausa ${def.breakMin} min` : '', def.place].filter(Boolean).join(' · ');
      return h('button', {
        class: ['set-row', 'code-row', u && 'unconfirmed'], type: 'button', dataset: { code: def.code, fkey: `code-${def.code}` },
        'aria-label': `${def.code === '-' ? 'Libre' : def.code}: ${displayName(def)}${hasTime(def) ? `, ${timeRange(def)}` : ''}${u ? ', horario sin confirmar' : ''}`,
        on: { click: () => ctx.openCode(def.code) },
      },
      h('span', { class: 'code-badge' }, badgeFromDef(def, { title: false })),
      h('span', { class: 'set-row-main' },
        h('span', { class: 'set-label' }, isPlace ? `Lugar ${def.code}` : displayName(def)),
        sub ? h('span', { class: ['set-sub', isPlace && !def.place && 'faint'] }, sub) : null),
      u ? h('span', { class: 'pill pill-warn' }, u.next ? 'Confirmar' : 'Sin confirmar') : null,
      h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, icon('chevronRight')));
    };
    const pending = [...unconf.values()].filter((v) => v.next).map((v) => v.def);
    const noAddress = places.filter((d) => !d.place).length;
    return h('section', { class: 'set-group', id: 'set-codes' },
      h('h2', { class: 'set-title' }, 'Mis turnos y horarios'),
      pending.length ? h('div', { class: 'notice notice-warn' }, icon('warning'), h('p', {},
        h('b', {}, pending.length === 1 ? `Confirma el horario de ${pending[0].code}. ` : `Confirma los horarios de ${pending.map((d) => d.code).join(', ')}. `),
        'La app los supuso; tócalos para revisarlos.')) : null,
      h('div', { class: 'card set-card codes-card' },
        primary.map(codeRow),
        places.length ? h('details', { class: 'places-group', dataset: { fkey: 'places' }, 'data-testid': 'places' },
          h('summary', { class: 'set-row' },
            h('span', { class: 'code-badge places-badges', 'aria-hidden': 'true' }, places.slice(0, 2).map((d) => badgeFromDef(d, { size: 'sm', title: false }))),
            h('span', { class: 'set-row-main' },
              h('span', { class: 'set-label' }, `Lugares (${places.length})`),
              h('span', { class: 'set-sub' }, noAddress === places.length ? 'Toca para poner sus direcciones' : places.map((d) => d.code).join(', '))),
            icon('chevronDown', 'icon chev')),
          h('div', { class: 'places-body' }, places.map(codeRow))) : null,
        showAllCodes && rest.length ? [h('h3', { class: 'set-subtitle' }, 'Otros códigos'), ...rest.map(codeRow)] : null),
      h('div', { class: 'btn-stack' },
        rest.length ? h('button', {
          class: 'btn btn-plain btn-block', type: 'button', 'data-testid': 'codes-all', dataset: { fkey: 'codes-all' },
          on: { click: () => { showAllCodes = !showAllCodes; refresh(); } },
        }, showAllCodes ? 'Ver menos códigos' : `Ver todos los códigos (${rest.length} más)`) : null,
        h('button', { class: 'btn btn-secondary btn-block', type: 'button', 'data-testid': 'code-add', on: { click: () => ctx.openCode(null) } }, icon('plus'), 'Añadir código')),
      h('p', { class: 'set-footer' }, 'Toca un código para cambiar su horario de todos los días, su pausa o su lugar. Para un solo día, tócalo en el Calendario.'));
  }

  // ---------- 3. Horas de contrato y recordatorios ----------
  function contract(s) {
    const name = h('input', {
      class: 'input input-inline input-name', value: s.name || '', maxlength: '30', placeholder: 'Tu nombre', 'aria-label': 'Nombre', autocomplete: 'given-name',
      dataset: { fkey: 'name' }, on: { change: (e) => set({ name: e.target.value.trim() }) },
    });
    const hours = h('input', {
      class: 'input input-inline input-num', value: fmtNum(Number(s.weeklyHours) || 35), inputmode: 'decimal', 'aria-label': 'Horas por semana',
      dataset: { fkey: 'weeklyHours' },
      on: { change: (e) => {
        const n = parseNum(e.target.value);
        if (!(n > 0 && n <= 60)) { ctx.toast('Escribe un número de horas entre 1 y 60.', { type: 'error' }); e.target.value = fmtNum(Number(s.weeklyHours) || 35); return; }
        set({ weeklyHours: Math.round(n * 100) / 100 });
        savedToast(ctx, `Contrato: ${fmtNum(n)} h por semana`);
      } },
    });
    const daily = (Number(s.weeklyHours) || 35) / (Number(s.workDaysPerWeek) || 5);
    return group('Horas de contrato', [
      row('Horas por semana', h('span', { class: 'inline-unit' }, hours, h('span', { class: 'unit' }, 'h')), { icon: 'clock', sub: `${formatHours(daily * 60)} por día (lun–vie)` }),
      row('Tu nombre', name, { icon: 'user' }),
    ], { id: 'set-hours' });
  }

  function reminders(state) {
    const r = state.settings.reminders;
    const sy = state.settings.sync, nt = state.settings.ntfy;
    const st = syncState(state, ctx.now());
    const calOk = ['ok', 'readonly', 'busy'].includes(st.kind);
    const ntfyOk = nt.enabled && nt.topic && !nt.lastError;
    let footer;
    if (calOk) footer = `✅ Los avisos van al Calendario del iPhone${ntfyOk ? ' y a ntfy' : ''}, si te suscribiste con «Suscribirme en el iPhone».`;
    else if (sy.enabled && st.kind === 'error') footer = '⚠️ El calendario no se está actualizando: los avisos de los turnos nuevos pueden no llegar. Mira «Calendario del iPhone», arriba.';
    else if (sy.enabled && (st.kind === 'pending' || st.kind === 'transient')) footer = '⏳ El calendario se está preparando. Los avisos llegarán cuando esté listo y te suscribas.';
    else if (ntfyOk) footer = '✅ Los avisos te llegan por ntfy.';
    else footer = '⚠️ Todavía no te llegan avisos: falta conectar el Calendario del iPhone (arriba).';
    const time = h('input', {
      type: 'time', class: 'input input-inline input-time', value: r.eveningTime || '20:00', 'aria-label': 'Hora del aviso de la víspera',
      disabled: !r.eveningBefore, dataset: { fkey: 'eveningTime' },
      on: { change: (e) => { if (e.target.value) set({ reminders: { eveningTime: e.target.value } }); } },
    });
    const mins = h('select', {
      class: 'input input-inline select', 'aria-label': 'Minutos antes del turno', disabled: !r.beforeStart, dataset: { fkey: 'minutesBefore' },
      value: String(r.minutesBefore), on: { change: (e) => set({ reminders: { minutesBefore: Number(e.target.value) } }) },
    }, [...new Set([...MINUTES, Number(r.minutesBefore) || 60])].sort((a, b) => a - b).map((m) => h('option', { value: String(m) }, minutesText(m))));
    return group('Recordatorios', [
      switchRow('La víspera', 'eve', r.eveningBefore, (v) => set({ reminders: { eveningBefore: v } }), { icon: 'bell', sub: 'Un aviso la noche antes' }),
      row('A las', time, { cls: 'set-row-sub' }),
      switchRow('Antes del turno', 'pre', r.beforeStart, (v) => set({ reminders: { beforeStart: v } }), { icon: 'clock', sub: 'Un aviso poco antes de empezar' }),
      row('Cuándo', mins, { cls: 'set-row-sub' }),
    ], { id: 'set-reminders', footer });
  }

  // ---------- 4. Copia de seguridad ----------
  function backup() {
    const fileInput = h('input', {
      type: 'file', accept: 'application/json,.json', class: 'visually-hidden', tabindex: '-1', 'data-testid': 'import-file', id: 'import-file-input',
      on: { change: async () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (f) await importText(await f.text(), { from: 'del archivo' });
      } },
    });
    return group('Copia de seguridad', [
      row('Exportar copia', actionButton('export', 'Exportar', 'share', async () => {
        const json = exportBackup(store.get(), { now: ctx.now() });
        const res = await shareOrDownload(`turnos-mauricio-${toKey(ctx.now())}.json`, json, 'application/json');
        if (res === 'downloaded') ctx.toast('Copia descargada', { type: 'ok' });
      }, 'btn-tinted btn-sm'), { icon: 'download', sub: 'Tus turnos y ajustes en un archivo' }),
      row('Importar copia', h('label', { class: 'btn btn-tinted btn-sm', for: 'import-file-input', role: 'button', tabindex: '0', on: { keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } } } }, icon('upload'), 'Importar'),
        { icon: 'upload', sub: 'Reemplaza los datos de este teléfono (se puede deshacer)' }),
      fileInput,
    ], { id: 'set-backup', footer: 'La copia no lleva la conexión del calendario: en otro teléfono, después de importarla, pega otra vez el enlace.' });
  }

  // Importar (archivo o copia de internet): vista previa, confirmación, copia local de seguridad y «Deshacer»
  async function importText(text, { from = 'del archivo', savedAt = null } = {}) {
    const now = ctx.now();
    let force = false;
    let preview;
    try {
      preview = importBackup(store.get(), text, { now });
    } catch (e) {
      if (e?.code !== 'EMPTY_BACKUP') { ctx.toast(e.message, { type: 'error', duration: 7000 }); return; }
      const ok = await confirmDialog({
        icon: '⚠️', title: 'Esa copia está vacía', danger: true,
        text: 'No tiene ningún día con turnos. Si la importas, este teléfono se queda sin turnos.',
        ok: 'Importar igualmente', cancel: 'No importar',
      });
      if (!ok) return;
      force = true;
      try { preview = importBackup(store.get(), text, { now, force }); } catch (e2) { ctx.toast(e2.message, { type: 'error' }); return; }
    }
    const n = Object.keys(preview.days).length;
    const localDays = store.get().days || {};
    const local = Object.keys(localDays).length;
    let at = savedAt;
    if (!at) { try { at = JSON.parse(text)?.exportedAt || null; } catch { at = null; } }
    const newestLocal = Object.values(localDays).map((d) => d?.updatedAt || '').sort().pop() || '';
    const localNewer = Boolean(at && newestLocal && newestLocal > at);
    const ok = await confirmDialog({
      icon: '📥', title: '¿Reemplazar con esta copia?', danger: true,
      text: `La copia ${from}${at ? ` (del ${dateTime(at)})` : ''} tiene ${plural(n, 'día', 'días')} con turnos; este teléfono tiene ${plural(local, 'día', 'días')}. `
        + `Los datos de este teléfono se reemplazarán.${localNewer ? ' Ojo: aquí hay cambios más nuevos que la copia.' : ''}`,
      ok: 'Reemplazar', cancel: 'Cancelar',
    });
    if (!ok) return;
    const backupKey = saveBeforeImport(store.get(), ls, { now: ctx.now() });
    if (!backupKey && !(await confirmDialog({
      title: 'No se podrá deshacer', text: 'No hay espacio para guardar una copia de lo actual: no se podrá deshacer. ¿Importar igualmente?',
      ok: 'Importar', cancel: 'Cancelar', danger: true,
    }))) return;
    try {
      store.set((s) => importBackup(s, text, { now: ctx.now(), force }));
    } catch (e) {
      ctx.toast(e.message || 'No se pudo importar la copia.', { type: 'error' });
      return;
    }
    savedToast(ctx, `Copia restaurada: ${plural(n, 'día', 'días')}`, {
      duration: 10000,
      action: backupKey ? { label: 'Deshacer', run: () => undo(backupKey) } : undefined,
    });
  }

  function undo(key) {
    const prev = undoImport(ls, store.get(), { now: new Date(), key });
    if (!prev) return; // segundo toque: ya no hay copia
    store.set(() => prev);
    savedToast(ctx, 'Listo: todo está como antes');
  }

  // ---------- 5. Instalar ----------
  function install(state) {
    if (isStandalone()) return null;
    const hasDays = Object.keys(state.days || {}).length > 0;
    return h('section', { class: 'set-group', id: 'set-install' },
      h('h2', { class: 'set-title' }, 'Instalar en la pantalla de inicio'),
      h('div', { class: 'card set-card guide-card' },
        installSteps(),
        h('p', { class: 'hint' }, 'Importante: los datos de Safari y los de la app instalada están separados. Usa siempre el icono de la pantalla de inicio.'),
        hasDays ? h('p', { class: 'hint' }, 'Para pasar tus turnos de aquí a la app: «Exportar» en Copia de seguridad, y después «Importar» dentro de la app.') : null));
  }

  // ---------- 6. Opciones avanzadas (plegadas) ----------
  function advanced(state) {
    const s = state.settings.sync;
    const n = state.settings.ntfy;
    const f = form || { owner: s.owner || '', repo: s.repo || '', branch: s.branch || '', token: s.token || '' };
    const edit = (k) => (e) => { form = { ...(form || f), [k]: e.target.value.trim() }; };
    const input = (k, label, extra = {}) => h('input', {
      class: 'input', value: f[k], autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': label,
      dataset: { fkey: `gh-${k}` }, on: { input: edit(k) }, ...extra,
    });
    const token = input('token', 'Token de GitHub', { type: showToken ? 'text' : 'password', placeholder: 'github_pat_…', class: 'input input-token' });
    const eye = h('button', { class: 'icon-btn', type: 'button', 'aria-label': showToken ? 'Ocultar token' : 'Mostrar token', dataset: { fkey: 'eye' }, on: { click: () => { showToken = !showToken; refresh(); } } }, icon(showToken ? 'eyeOff' : 'eye'));
    const formCfg = () => normalizeSyncConfig({ ...(form || f) });
    const readOnly = isReadOnlyDevice(s);
    const canLink = s.enabled && isSyncKey(s.key) && !readOnly && Boolean(s.lastPushAt || s.lastPullAt);

    const tech = s.enabled ? h('ul', { class: 'tech-list' },
      h('li', {}, h('span', {}, 'Este dispositivo'), h('code', {}, s.deviceId || '—')),
      h('li', {}, h('span', {}, 'Publica'), h('span', {}, !s.publisher ? '—' : s.publisher === s.deviceId ? 'este dispositivo'
        : s.publisher === UNKNOWN_PUBLISHER ? 'otro dispositivo (desconocido)' : `otro (${s.publisher})`)),
      h('li', {}, h('span', {}, 'Copia (rev)'), h('span', {}, String(s.baseRev || 0))),
      h('li', {}, h('span', {}, 'Último envío'), h('span', {}, s.lastPushAt ? dateTime(s.lastPushAt) : '—')),
      h('li', {}, h('span', {}, 'Última lectura'), h('span', {}, s.lastPullAt ? dateTime(s.lastPullAt) : '—')),
      s.lastErrorDetail || s.lastError ? h('li', { class: 'tech-error' }, h('span', {}, 'Último error'), h('span', {}, `${s.lastErrorCode || ''} ${s.lastErrorDetail || s.lastError}`.trim())) : null) : null;

    const ghCard = h('div', { class: 'card set-card adv-card', id: 'set-github' },
      h('h3', { class: 'adv-title' }, 'Conexión con GitHub'),
      h('p', { class: 'hint' }, 'Un repositorio público solo para datos (no el de la app) y un token «fine-grained» con permiso Contents: Read and write solo en ese repositorio. Lo más fácil para Mauricio: enviarle un enlace con «Crear enlace para Mauricio».'),
      h('div', { class: 'field-row' },
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Usuario'), input('owner', 'Usuario de GitHub', { placeholder: 'usuario' })),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Repositorio'), input('repo', 'Repositorio', { placeholder: 'mauricio-datos' }))),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Rama (vacía = la principal)'), input('branch', 'Rama', { placeholder: '' })),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Token'), h('div', { class: 'input-with-btn' }, token, eye)),
      h('div', { class: 'btn-row' },
        actionButton('test', 'Probar', 'link', async () => {
          const cfg = formCfg();
          if (!cfg) { ctx.toast('Revisa los datos: usuario, repositorio, rama o token no válidos.', { type: 'error' }); return; }
          const r = await testConnection(cfg);
          ctx.toast(r.ok ? r.message : `${r.message} ${r.detail || ''}`.trim(), { type: r.ok ? 'ok' : 'error', duration: 7000 });
          if (r.ok && r.private) ctx.toast('Ojo: el repositorio es privado. El iPhone solo puede suscribirse a uno público.', { type: 'error', duration: 8000 });
          if (r.ok && r.warning) ctx.toast(r.warning, { type: 'error', duration: 9000 });
        }, 'btn-secondary btn-sm'),
        actionButton('connect', 'Guardar y conectar', 'cloud', async () => {
          const cfg = formCfg();
          if (!cfg) { ctx.toast('Revisa los datos: usuario, repositorio, rama o token no válidos.', { type: 'error' }); return; }
          const ok = await runSetup(ctx, cfg, { confirm: false });
          if (ok) form = null;
        }, 'btn-primary btn-sm')),
      tech,
      s.enabled ? h('div', { class: 'btn-row' },
        actionButton('push', 'Actualizar el calendario ahora', 'upload', () => ctx.background.runSync({ manual: true, force: true }), 'btn-secondary btn-sm'),
        // Cambiar la clave (CORE-API §4.2): solo en el que publica y con backup.json ya borrado
        s.publisher === s.deviceId && isSyncKey(s.key) ? actionButton('rekey', 'Cambiar la clave', 'refresh', async () => {
          const ok = await confirmDialog({
            icon: '🔑', title: '¿Cambiar la clave?', danger: true,
            text: 'Primero borra backup.json en el repositorio de datos (si sigue ahí, no se cambia nada). Después envía un enlace nuevo a los demás dispositivos: hasta entonces no podrán leer los turnos.',
            ok: 'Cambiar la clave', cancel: 'Cancelar',
          });
          if (!ok) return;
          const cur = store.get().settings.sync;
          const cfg = normalizeSyncConfig({ owner: cur.owner, repo: cur.repo, branch: cur.branch || '', token: cur.token, key: generateSyncKey() });
          if (!cfg) { ctx.toast('La conexión guardada no es válida: revisa usuario, repositorio y token.', { type: 'error' }); return; }
          await runSetup(ctx, cfg, { confirm: false });
        }, 'btn-secondary btn-sm') : null,
        canLink ? h('button', {
          class: 'btn btn-tinted btn-sm', type: 'button', 'data-testid': 'make-link',
          on: { click: async () => {
            const link = buildSetupLink(location.href, store.get().settings.sync);
            const ok = await copyText(link);
            ctx.toast(ok ? 'Enlace copiado. Lleva la clave y el token: envíalo solo a Mauricio.' : 'No se pudo copiar', { type: ok ? 'ok' : 'error', duration: 8000 });
          } },
        }, icon('copy'), 'Crear enlace para Mauricio') : null,
        h('button', {
          class: 'btn btn-danger-plain btn-sm', type: 'button',
          on: { click: async () => {
            const ok = await confirmDialog({ title: '¿Desconectar el calendario?', text: 'Este dispositivo dejará de leer y de publicar. El calendario de internet no se borra.', ok: 'Desconectar', danger: true });
            if (ok) set({ sync: { enabled: false } });
          } },
        }, 'Desconectar')) : null);

    const placesCard = h('div', { class: 'card set-card adv-card' },
      h('h3', { class: 'adv-title' }, 'Calendario publicado'),
      switchRow('Publicar lugares en el calendario', 'places', Boolean(s.publishPlaces), (v) => set({ sync: { publishPlaces: v } }), {
        sub: 'El calendario es público: quien tenga el enlace ve los horarios. Con esto también verá los lugares (F51, S31…). Las notas nunca se publican.',
      }),
      row('Archivo .ics', actionButton('ics', 'Exportar', 'share', async () => {
        const res = await shareOrDownload('turnos.ics', buildICS(store.get(), { now: ctx.now() }), 'text/calendar');
        if (res === 'downloaded') ctx.toast('Archivo turnos.ics descargado', { type: 'ok' });
      }, 'btn-tinted btn-sm'), { sub: 'Para importar una sola vez (no se actualiza)' }));

    const next = Object.entries(n.scheduled || {}).filter(([k, v]) => k !== 'turnos-keepalive' && new Date(v.at) > ctx.now())
      .map(([, v]) => new Date(v.at)).sort((a, b) => a - b)[0];
    const topicInput = h('input', {
      class: 'input input-mono', value: n.topic || '', placeholder: 'turnos-mauricio-…', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Tema de ntfy', dataset: { fkey: 'topic' }, on: { change: (e) => set({ ntfy: { topic: e.target.value.trim().replace(/\s+/g, '-'), lastError: null } }) },
    });
    const server = h('input', { class: 'input', value: n.server || 'https://ntfy.sh', 'aria-label': 'Servidor de ntfy', autocapitalize: 'off', spellcheck: 'false', dataset: { fkey: 'ntfyServer' }, on: { change: (e) => set({ ntfy: { server: e.target.value.trim() || 'https://ntfy.sh' } }) } });
    const ntfyCard = h('div', { class: 'card set-card adv-card', id: 'set-ntfy' },
      h('h3', { class: 'adv-title' }, 'Notificaciones con ntfy (opcional)'),
      h('p', { class: 'hint' }, 'Avisos como notificaciones con la app gratuita «ntfy», sin cuenta. Útil para cambios de última hora.'),
      switchRow('Usar ntfy', 'ntfyEnabled', Boolean(n.enabled), (v) => {
        const patch = { ntfy: { enabled: v, lastError: null } };
        if (v && !store.get().settings.ntfy.topic) patch.ntfy.topic = randomTopic();
        set(patch);
        ctx.background?.ntfyNow({ manual: true });
      }, { sub: n.lastError ? n.lastError : n.enabled ? (next ? `Próximo aviso: ${dateTime(next.toISOString())}` : 'No hay avisos en los próximos 3 días') : 'Desactivado', cls: n.lastError ? 'has-error' : '' }),
      n.enabled || n.topic ? h('div', { class: 'set-block' },
        h('span', { class: 'label' }, 'Tema (como una contraseña: no lo compartas)'),
        h('div', { class: 'input-with-btn' }, topicInput,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copiar tema', on: { click: async () => { const ok = await copyText(store.get().settings.ntfy.topic); ctx.toast(ok ? 'Tema copiado' : 'No se pudo copiar', { type: ok ? 'ok' : 'error' }); } } }, icon('copy'))),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-secondary btn-sm', type: 'button', on: { click: async () => {
            if (store.get().settings.ntfy.topic) {
              const ok = await confirmDialog({ title: '¿Crear un tema nuevo?', text: 'Habrá que suscribirse otra vez en la app ntfy con el tema nuevo.', ok: 'Crear nuevo' });
              if (!ok) return;
            }
            set({ ntfy: { topic: randomTopic(), lastError: null } });
          } } }, icon('refresh'), 'Tema nuevo'),
          actionButton('ntfyTest', 'Enviar prueba', 'bell', async () => {
            const r = await testNtfy(store.get().settings.ntfy);
            ctx.toast(r.message, { type: r.ok ? 'ok' : 'error', duration: 6000 });
          }, 'btn-tinted btn-sm')),
        details('guide-ntfy', 'Cómo activarlo (paso a paso)',
          steps(
            ['Instala la app gratuita ', h('b', {}, '«ntfy»'), ' desde la App Store.'],
            ['Ábrela y toca ', h('b', {}, '«+»'), ' (arriba).'],
            ['Escribe el tema: ', h('code', { class: 'topic-code' }, n.topic || '(toca «Tema nuevo»)'), '.'],
            ['Toca ', h('b', {}, '«Subscribe»'), ' (suscribirse) y permite las notificaciones.'],
            ['Vuelve aquí y toca ', h('b', {}, '«Enviar prueba»'), '. Debería llegarte un aviso.']),
          h('p', { class: 'hint' }, 'ntfy programa los avisos con hasta 3 días de antelación: hay que abrir Turnos de vez en cuando.'),
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Servidor'), server))) : null);

    const copies = listBeforeImport(ls);
    const restoreCard = h('div', { class: 'card set-card adv-card', id: 'set-restore' },
      h('h3', { class: 'adv-title' }, 'Restaurar'),
      isConfigured(s) && s.enabled ? [
        row('Juntar con la copia de internet', actionButton('pull', 'Juntar', 'cloud', async () => {
          const r = await ctx.syncQueue.pull();
          if (r.ok) ctx.toast(r.pulledDays?.length ? `Listo: llegaron ${plural(r.pulledDays.length, 'día', 'días')} de la copia de internet.` : 'Listo: no había nada nuevo en la copia de internet.', { type: 'ok' });
          else ctx.toast(r.error.message, { type: 'error', duration: 7000 });
        }, 'btn-tinted btn-sm'), { sub: 'Recomendado: no se pierde nada de este teléfono' }),
        row('Reemplazar con la copia de internet', actionButton('replace', 'Reemplazar', 'download', async () => {
          let got;
          try { got = await fetchRemoteBackup(store.get().settings.sync); } catch (e) { ctx.toast(e.message || 'No se pudo descargar la copia.', { type: 'error', duration: 7000 }); return; }
          await importText(JSON.stringify(got.data), { from: 'de internet', savedAt: got.meta?.savedAt || null });
        }, 'btn-tinted btn-sm'), { sub: 'Este teléfono queda igual que la copia (se puede deshacer)' }),
      ] : h('p', { class: 'hint' }, 'Con el calendario conectado puedes recuperar aquí la copia de internet.'),
      copies.map((c) => row(`Copia de antes de importar`, h('button', {
        class: 'btn btn-tinted btn-sm', type: 'button',
        on: { click: async () => {
          const ok = await confirmDialog({ title: '¿Volver a esta copia?', text: `Copia del ${dateTime(c.at)} con ${plural(c.days, 'día', 'días')}. Reemplaza los datos de este teléfono.`, ok: 'Volver a esta copia', danger: true });
          if (ok) undo(c.key);
        } },
      }, 'Recuperar'), { sub: `${dateTime(c.at)} · ${plural(c.days, 'día', 'días')}` })));

    const dangerCard = h('div', { class: 'card set-card adv-card' },
      h('h3', { class: 'adv-title' }, 'Borrar'),
      row('Borrar todos los datos', h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-testid': 'wipe', on: { click: wipe } }, icon('trash'), 'Borrar'),
        { sub: 'Turnos, códigos y ajustes de este dispositivo. La copia de internet no se toca.' }));

    return h('details', { class: 'advanced', id: 'set-advanced', dataset: { fkey: 'advanced' }, 'data-testid': 'advanced' },
      h('summary', {}, h('span', { class: 'adv-sum-main' }, h('span', { class: 'adv-sum-title' }, 'Opciones avanzadas'), h('span', { class: 'adv-sum-sub' }, 'Para quien te ayuda con la app')), icon('chevronDown', 'icon chev')),
      h('div', { class: 'advanced-body' }, ghCard, placesCard, ntfyCard, restoreCard, dangerCard));
  }

  async function wipe() {
    const ok1 = await confirmDialog({
      icon: '🗑️', title: '¿Borrar todos los datos?', danger: true,
      text: 'Se borran tus turnos, códigos y ajustes de este dispositivo (también la conexión del calendario). La copia de internet no se toca.',
      ok: 'Continuar', cancel: 'Cancelar',
    });
    if (!ok1) return;
    const ok2 = await confirmDialog({ title: '¿Seguro?', text: 'Este dispositivo se quedará vacío, como recién instalado.', ok: 'Sí, borrar todo', cancel: 'No, cancelar', danger: true });
    if (!ok2) return;
    // Lo de antes, entero (también la conexión del calendario y ntfy), para «Deshacer»
    const snapshot = store.get();
    // Avisos de ntfy ya programados: se cancelan antes (después ya no se sabría cuáles eran)
    const n = snapshot.settings.ntfy;
    if (n.enabled || Object.keys(n.scheduled || {}).length) {
      set({ ntfy: { enabled: false } });
      try { await ctx.background?.ntfyNow(); } catch { /* sin red: no pasa nada */ }
    }
    const key = saveBeforeImport(store.get(), ls, { now: ctx.now() });
    try { ls?.removeItem(DRAFT_KEY); } catch { /* nada */ }
    ctx.resetScan?.(); // la revisión a medias (en memoria) tampoco se queda
    form = null;
    store.set(() => updateSettings(createDefaultState(), { onboardingDone: true }));
    window.scrollTo(0, 0);
    if (store.saveOk?.() === false) { saveFailedToast(ctx); return; }
    ctx.toast('Datos borrados', { duration: 10000, action: { label: 'Deshacer', run: () => undoWipe(snapshot, key) } });
  }

  // Deshacer el borrado: todo como estaba, también el calendario conectado y ntfy (sus avisos se
  // cancelaron, así que se vuelven a programar)
  function undoWipe(snapshot, key) {
    const restored = { ...snapshot, settings: { ...snapshot.settings, ntfy: { ...snapshot.settings.ntfy, scheduled: {} } } };
    store.set(() => restored);
    if (key) { try { ls?.removeItem(key); } catch { /* nada */ } }
    savedToast(ctx, 'Listo: todo está como antes');
  }

  // ---------- 7. Acerca de ----------
  function about() {
    return group('Acerca de', [
      row('Turnos de Mauricio', h('span', { class: 'muted' }, `v${ctx.version}`), { icon: 'heart' }),
      h('p', { class: 'set-note' }, h('b', {}, 'Tus datos: '),
        'se guardan en este teléfono. Si conectas el calendario, tus horarios se publican en internet: quien tenga el enlace puede verlos (sin notas; los lugares, solo si se activa). La copia completa va cifrada.'),
      h('button', { class: 'set-row set-row-btn', type: 'button', on: { click: () => showOnboarding(ctx, { again: true }) } },
        h('span', { class: 'set-icon si-sparkles', 'aria-hidden': 'true' }, icon('sparkles')),
        h('span', { class: 'set-row-main' }, h('span', { class: 'set-label' }, 'Ver la bienvenida otra vez')),
        h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, icon('chevronRight'))),
    ], { id: 'set-about' });
  }

  function render(state) {
    const s = state.settings;
    setChildren(el,
      h('header', { class: 'page-head' }, h('h1', { class: 'large-title' }, 'Ajustes')),
      banners(ctx, state, 'ajustes'),
      calendar(state),
      codes(state),
      contract(s),
      reminders(state),
      backup(),
      install(state),
      advanced(state),
      about(),
    );
  }

  function scrollToSection(section) {
    requestAnimationFrame(() => {
      const target = document.getElementById(`set-${section}`);
      const adv = document.getElementById('set-advanced');
      if (target && adv && adv.contains(target)) adv.open = true;
      target?.scrollIntoView({ block: 'start' });
    });
  }

  return {
    el,
    render,
    // opts: { section: 'calendar' | 'codes' | 'advanced' | … } o { code }
    onShow(opts) {
      if (opts?.code) {
        const c = opts.code;
        scrollToSection('codes');
        requestAnimationFrame(() => ctx.openCode(c));
        return true;
      }
      if (opts?.section) { scrollToSection(opts.section); return true; }
      return false;
    },
    importText,
  };
}
