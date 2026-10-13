// Pestaña "Ajustes" (SPEC §10–§13): 1) Calendario del iPhone (o del teléfono) y calendarios de la
// familia, 2) Mis turnos y horarios, 3) Horas de contrato (+ «Contrato y nómina», plegado),
// Recordatorios y Tu nombre, 4) Copia de seguridad, 5) Instalar, 6) Opciones avanzadas (plegadas),
// 7) Acerca de.
import {
  SUPPLEMENT_NOTE, UNKNOWN_PUBLISHER, addDays, balanceSettings, buildICS, buildPersonLink, buildSetupLink, calendarName,
  calendarUrls, cleanPersonName, createDefaultState, exportBackup, fetchRemoteBackup, formatHours, formatMonth,
  generateSyncKey, hasTime, importBackup, isSyncKey, listBeforeImport, listCalendars, normalizeSyncConfig,
  publicName, randomTopic, saveBeforeImport, suggestPlanName, supplementSettings, testConnection, testNtfy, toKey, travelOf,
  updateSettings,
} from '../core/index.js';
import { badgeFromDef, displayName, groupCodes, timeRange } from './badge.js';
import {
  ago, cap, copyText, dateTime, fmtNum, h, isStandalone, minutesText, parseNum, plural, safeStorage, setChildren, shareOrDownload,
} from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, openSheet } from './sheet.js';
import { unconfirmedInUse } from './attention.js';
import { showOnboarding } from './onboarding.js';
import {
  alertsNotice, copyInfo, openPasteSetup, ownLinkLabel, restoreCopy, runSetup, subscribeButton, subscribeSteps, subscribedBlock, takeOver,
} from './setup.js';
import { banners, inSafariTab, saveFailedToast, savedToast } from './banners.js';
import { androidInstallSteps, installButton, installSteps, openInstallSheet } from './install.js';
import { androidGuides, copyLine, copyLinkButton, openFamilyCalendar } from './calguide.js';
import { appleDevice, calendarPhrase, calendarTitle, deviceWord, subscribeLabel } from './platform.js';
import { calendarReady, isConfigured, isSubscribed, markSubscribed, syncState, webcalUrl } from './syncStatus.js';
import { DRAFT_KEY } from './scan.js';

const MINUTES = [15, 30, 45, 60, 90, 120];
const SUP_LABEL = { night: 'Noche', saturday: 'Sábado', sunday: 'Domingo', holiday: 'Festivo' };
const CORE_SHIFTS = ['F1', 'S1', 'N1', 'Z1'];
const SOON_DAYS = 60; // «Mis turnos»: los turnos que se usan en los próximos ~2 meses
// Con estos errores el enlace llevaría una clave o un token que no valen (o que no pueden publicar)
const LINK_BLOCKERS = ['DECRYPT', 'NO_KEY', 'AUTH', 'FORBIDDEN'];
const LINK_BLOCK_WHY = { DECRYPT: 'la clave no vale', NO_KEY: 'falta la clave', AUTH: 'el token no vale', FORBIDDEN: 'el token no tiene permiso para escribir' };

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

  // ---------- 1. Calendario del iPhone (o del teléfono) ----------
  function calendar(state) {
    const s = state.settings.sync;
    const plat = ctx.platform;
    const st = syncState(state, ctx.now(), { busy: ctx.background?.busy?.() });
    const configured = s.enabled && isConfigured(s);
    const statusIcon = { off: 'calendar', ok: 'check', busy: 'refresh', pending: 'refresh', transient: 'cloud', readonly: 'phone', error: 'warning' }[st.kind];
    const urls = configured ? calendarUrls(s) : null;
    const calName = calendarName(state);

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
    const copy = () => (calendarReady(s) && urls ? copyLinkButton(ctx, urls.https, { cls: 'btn-tinted btn-block' }) : null);
    // Suscripción: «Suscrito ✓» si ya se hizo en este dispositivo; si no, el botón (secundario si hay error)
    const subscription = (secondary) => {
      if (plat === 'desktop') {
        // Ordenador (quien ayuda): el enlace para copiarlo; las guías van debajo
        return [copy(), secondary ? null : h('p', { class: 'set-hint' }, 'Para verlo en el teléfono, usa la app Turnos del teléfono. Aquí puedes copiar el enlace (por ejemplo, para Google Calendar).')];
      }
      if (isSubscribed(s)) return [subscribedBlock(ctx, s, { onChange: refresh }), plat === 'android' ? copy() : null];
      // Android: los pasos (instalar ICSx⁵, que cuesta 1,99 €) van antes del botón, que abre ICSx⁵ o Google Play
      const stepsHere = secondary ? null : subscribeSteps();
      return [
        secondary ? null : alertsNotice(),
        plat === 'android' ? stepsHere : null,
        subscribeButton(ctx, s, { secondary, onTap: () => setTimeout(refresh, 400) }),
        plat === 'android' ? copy() : stepsHere,
        // Quien se suscribió con una versión anterior (sin recordarlo): para no invitar a repetirlo
        calendarReady(s) ? h('button', {
          class: 'link-btn link-center link-small', type: 'button', 'data-testid': 'already-subscribed',
          on: { click: () => { markSubscribed(webcalUrl(s), ctx.now()); refresh(); } },
        }, plat === 'android' ? 'Ya lo tengo en mi calendario' : 'Ya me suscribí antes') : null,
      ];
    };

    if (!configured) {
      if (inSafariTab()) {
        // En Safari el enlace no sirve (se guardaría aquí, no en la app): primero instalar
        blocks.push(h('div', { class: 'set-actions' },
          h('p', { class: 'set-hint' }, 'Primero pon la app en tu pantalla de inicio. El enlace que te envíen se pega dentro de la app, no aquí en Safari.'),
          h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'cal-install', on: { click: () => openInstallSheet(ctx) } }, icon('phone'), 'Primero instala la app')));
      } else {
        blocks.push(h('div', { class: 'set-actions' },
          h('p', { class: 'set-hint' }, plat === 'android'
            ? 'Quien te ayuda con la app te envía un enlace de configuración (por WhatsApp o correo). Ábrelo en este teléfono, o cópialo y toca aquí:'
            : 'Quien te ayuda con la app te envía un enlace de configuración (por WhatsApp o correo). Cuando lo tengas, toca aquí:'),
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
      } else if (st.remedy === 'switch') {
        // Los turnos de aquí son de otro calendario: pasar al conectado (pregunta antes y se puede deshacer)
        fix = actionButton('switchfix', 'Cambiar al calendario conectado…', 'refresh', async () => {
          const cur = store.get().settings.sync;
          const cfg = normalizeSyncConfig({ owner: cur.owner, repo: cur.repo, branch: cur.branch || '', dir: cur.dir || '', token: cur.token, key: cur.key || '' });
          if (!cfg) { ctx.toast('La conexión guardada no es válida: pide un enlace nuevo.', { type: 'error' }); return; }
          await runSetup(ctx, cfg, { confirm: false });
        }, 'btn-primary btn-block');
        fix = [fix, linkBtn(false)];
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

    // Guías debajo de la tarjeta: iPhone (a mano); Android y ordenador (ICSx⁵ y Google Calendar)
    let guides = null;
    if (configured && plat === 'ios') {
      guides = details('guide-cal', '¿No se abre o no se actualiza?',
        h('p', { class: 'hint' }, `Si al tocar «${subscribeLabel()}» no pasa nada, hazlo a mano: abre `, h('b', {}, 'Ajustes'),
          ` del ${appleDevice()} (en algunos se llama «Configuración») → Calendario → Cuentas → «Agregar cuenta» (o «Añadir cuenta») → Otra → «Agregar calendario suscrito», y pega este enlace:`),
        urls ? copyLine(ctx, urls.https) : null,
        h('p', { class: 'hint' }, 'En iOS 18 el camino es: Ajustes → Apps → Calendario → Cuentas de calendario.'),
        h('p', { class: 'hint' }, h('b', {}, 'Para que se actualice más a menudo: '), 'Ajustes → Calendario → Cuentas → «Obtener datos» → en «Calendarios suscritos» elige «Cada 15 minutos» o «Cada hora».'),
        h('p', { class: 'hint' }, 'Si cambias un turno de mañana, abre un momento la app Calendario para que lo recoja.'));
    } else if (configured) {
      guides = h('div', { class: 'guide-group' }, androidGuides(ctx, { calName, buttonLabel: subscribeLabel() }));
    }
    return h('section', { class: 'set-group', id: 'set-calendar' },
      h('h2', { class: 'set-title' }, calendarTitle()),
      h('div', { class: 'card set-card cal-card' }, blocks),
      guides);
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
        ? [def.place || 'Sin dirección', travelOf(def) ? `${travelOf(def)} min de viaje` : ''].filter(Boolean).join(' · ')
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

  // ---------- 3. Horas de contrato (+ «Contrato y nómina»), recordatorios y nombre ----------
  function contract(state) {
    const s = state.settings;
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
    return h('section', { class: 'set-group', id: 'set-hours' },
      h('h2', { class: 'set-title' }, 'Horas de contrato'),
      h('div', { class: 'card set-card' },
        row('Horas por semana', h('span', { class: 'inline-unit' }, hours, h('span', { class: 'unit' }, 'h')), { icon: 'clock', sub: `${formatHours(daily * 60)} por día (lun–vie)` })),
      payroll(state));
  }

  // Campo numérico en línea que guarda al cambiar (valida; si no vale, avisa y vuelve al valor guardado)
  function numField(fkey, label, value, { parse, save, unit, width = 'input-num', placeholder = '', mode = 'decimal' }) {
    const shown = value === null || value === undefined ? '' : String(value);
    return h('span', { class: 'inline-unit' },
      h('input', {
        class: ['input', 'input-inline', width], value: shown, inputmode: mode, 'aria-label': label, placeholder, dataset: { fkey },
        on: { change: (e) => {
          const r = parse(e.target.value);
          if (r.error) { ctx.toast(r.error, { type: 'error' }); e.target.value = shown; return; }
          save(r.value);
          savedToast(ctx, 'Guardado');
        } },
      }),
      unit ? h('span', { class: 'unit' }, unit) : null);
  }

  // '-3,5' / '−3,5' / '+12' → número (NaN si no lo es)
  const parseSigned = (v) => parseNum(String(v ?? '').replace(/[−–]/g, '-').replace(/^\+/, ''));

  // «Contrato y nómina» (plegado): vacaciones, saldo de horas inicial y suplementos (SPEC §13.3–§13.4)
  function payroll(state) {
    const sp = supplementSettings(state);
    const b = balanceSettings(state);
    const pct = (k) => numField(`sup-${k}`, `Suplemento de ${SUP_LABEL[k].toLowerCase()} (%)`, fmtNum(sp[k].pct, 1), {
      unit: '%',
      parse: (v) => { const n = parseNum(v); return n >= 0 && n <= 300 ? { value: Math.round(n * 10) / 10 } : { error: 'Escribe un porcentaje entre 0 y 300.' }; },
      save: (n) => set({ supplements: { [k]: { pct: n } } }),
    });
    const timeIn = (k, end) => h('input', {
      type: 'time', class: 'input input-inline input-time', value: sp[k][end], 'aria-label': `${SUP_LABEL[k]}: ${end === 'from' ? 'desde' : 'hasta'}`,
      dataset: { fkey: `sup-${k}-${end}` },
      on: { change: (e) => { if (e.target.value) { set({ supplements: { [k]: { [end]: e.target.value } } }); savedToast(ctx, 'Guardado'); } } },
    });
    const windowRow = (k) => h('div', { class: 'set-row set-row-sub pay-window', role: 'group', 'aria-label': `Franja de ${SUP_LABEL[k].toLowerCase()}` },
      timeIn(k, 'from'), h('span', { class: 'pay-dash', 'aria-hidden': 'true' }, '–'), timeIn(k, 'to'));
    // Mes desde el que se cuenta el saldo: automático o uno de los últimos 24 meses
    const now = ctx.now();
    const months = [];
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    if (b.overtimeStartMonth && !months.includes(b.overtimeStartMonth)) months.push(b.overtimeStartMonth);
    const monthSel = h('select', {
      class: 'input input-inline select', 'aria-label': 'Mes desde el que se cuenta el saldo', dataset: { fkey: 'ot-month' },
      value: b.overtimeStartMonth || '',
      on: { change: (e) => { set({ balances: { overtimeStartMonth: e.target.value || null } }); savedToast(ctx, 'Guardado'); } },
    }, h('option', { value: '' }, 'Automático'), months.map((m) => h('option', { value: m }, cap(formatMonth(+m.slice(0, 4), +m.slice(5, 7))))));
    const startH = b.overtimeStartMin / 60;
    const content = [
      h('div', { class: 'notice notice-info small pay-note', 'data-testid': 'payroll-note' }, icon('info'), h('p', {}, SUPPLEMENT_NOTE)),
      h('h3', { class: 'set-subtitle' }, 'Vacaciones'),
      h('div', { class: 'card set-card' },
        row('Días al año', numField('vac-days', 'Días de vacaciones al año', fmtNum(b.vacationDaysPerYear, 1), {
          unit: 'días',
          parse: (v) => { const n = parseNum(v); return n >= 0 && n <= 366 ? { value: Math.round(n * 2) / 2 } : { error: 'Escribe un número de días entre 0 y 366.' }; },
          save: (n) => set({ balances: { vacationDaysPerYear: n } }),
        })),
        row('Del año pasado', numField('vac-carry', 'Días de vacaciones del año pasado', fmtNum(b.vacationCarryOver, 1), {
          unit: 'días',
          parse: (v) => { const n = String(v).trim() === '' ? 0 : parseNum(v); return n >= 0 && n <= 366 ? { value: Math.round(n * 2) / 2 } : { error: 'Escribe un número de días entre 0 y 366.' }; },
          save: (n) => set({ balances: { vacationCarryOver: n } }),
        }), { sub: 'Días que te quedaron sin usar' })),
      h('h3', { class: 'set-subtitle' }, 'Saldo de horas'),
      h('div', { class: 'card set-card' },
        row('Saldo al empezar', numField('ot-start', 'Saldo de horas al empezar', startH ? fmtNum(startH, 2) : '0', {
          unit: 'h',
          parse: (v) => { const n = String(v).trim() === '' ? 0 : parseSigned(v); return Number.isFinite(n) && Math.abs(n) <= 100000 ? { value: Math.round(n * 60) } : { error: 'Escribe las horas, por ejemplo 12,5 o -3.' }; },
          save: (n) => set({ balances: { overtimeStartMin: n } }),
        }), { sub: 'Horas de más (o de menos, con «-») que ya tenías' }),
        row('Desde', monthSel, { sub: 'El mes en que empiezas a contar', cls: 'set-row-stack' })),
      h('h3', { class: 'set-subtitle' }, 'Suplementos'),
      h('div', { class: 'card set-card' },
        row(SUP_LABEL.night, pct('night'), { sub: `${sp.night.from}–${sp.night.to}` }),
        windowRow('night'),
        row(SUP_LABEL.saturday, pct('saturday'), { sub: `${sp.saturday.from}–${sp.saturday.to}` }),
        windowRow('saturday'),
        row(SUP_LABEL.sunday, pct('sunday')),
        row(SUP_LABEL.holiday, pct('holiday'), { sub: 'Festivos de Berlín' }),
        row('Salario por hora', numField('wage', 'Salario por hora (€)', sp.hourlyWage === null ? '' : fmtNum(sp.hourlyWage, 2), {
          unit: '€', placeholder: '—',
          parse: (v) => {
            if (String(v).trim() === '') return { value: null };
            const n = parseNum(v);
            return n > 0 && n <= 500 ? { value: Math.round(n * 100) / 100 } : { error: 'Escribe el salario por hora, por ejemplo 18,50 (o déjalo vacío).' };
          },
          save: (n) => set({ supplements: { hourlyWage: n } }),
        }), { sub: 'Opcional: para estimar los € de suplementos' })),
      h('p', { class: 'set-footer' }, 'Comprueba tu contrato o tu nómina y cambia lo que no coincida. Los totales salen en la pestaña Horas.'),
    ];
    return h('details', { class: 'guide set-payroll', id: 'set-payroll', dataset: { fkey: 'payroll' }, 'data-testid': 'payroll' },
      h('summary', {}, h('span', { class: 'adv-sum-main' }, h('span', {}, 'Contrato y nómina'),
        h('span', { class: 'adv-sum-sub' }, 'Vacaciones, saldo de horas y suplementos')), icon('chevronDown', 'icon chev')),
      h('div', { class: 'guide-body payroll-body' }, content));
  }

  function reminders(state) {
    const r = state.settings.reminders;
    const sy = state.settings.sync, nt = state.settings.ntfy;
    const st = syncState(state, ctx.now());
    const calOk = ['ok', 'readonly', 'busy'].includes(st.kind);
    const ntfyOk = nt.enabled && nt.topic && !nt.lastError;
    const cal = calendarTitle();
    let footer;
    if (calOk) {
      footer = ctx.platform === 'ios'
        ? `✅ Los avisos van al ${calendarPhrase()}${ntfyOk ? ' y a ntfy' : ''}, si te suscribiste con «${subscribeLabel()}».`
        : `✅ Los avisos van al calendario del teléfono${ntfyOk ? ' y a ntfy' : ''}, si ${ctx.platform === 'android' ? `lo agregaste con «${subscribeLabel()}»` : 'lo agregaste a tu calendario'}.`;
    } else if (sy.enabled && st.kind === 'error') footer = `⚠️ El calendario no se está actualizando: los avisos de los turnos nuevos pueden no llegar. Mira «${cal}», arriba.`;
    else if (sy.enabled && (st.kind === 'pending' || st.kind === 'transient')) footer = '⏳ El calendario se está preparando. Los avisos llegarán cuando esté listo y te suscribas.';
    else if (ntfyOk) footer = '✅ Los avisos te llegan por ntfy.';
    else footer = `⚠️ Todavía no te llegan avisos: falta conectar el ${calendarPhrase()} (arriba).`;
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
      switchRow('Antes del turno', 'pre', r.beforeStart, (v) => set({ reminders: { beforeStart: v } }), { icon: 'clock', sub: 'Un aviso poco antes de salir o de empezar' }),
      row('Cuándo', mins, { cls: 'set-row-sub' }),
      switchRow('Avisarme para subir el plan', 'planUpload', r.planUpload !== false, (v) => set({ reminders: { planUpload: v } }), {
        icon: 'camera', sub: 'El día 20, si todavía no tienes el plan del mes siguiente',
      }),
    ], { id: 'set-reminders', footer });
  }

  // «Tu nombre» (saludo) y cómo sale en el plan (para leer la hoja del PC)
  function names(state) {
    const s = state.settings;
    const sug = suggestPlanName({ settings: { name: s.name, planName: '' } });
    // En el ordenador (quien ayuda): el nombre es el de la persona de estos turnos
    const pcName = ctx.platform === 'desktop';
    const name = h('input', {
      class: 'input input-inline input-name', value: s.name || '', maxlength: '60', placeholder: pcName ? 'Su nombre' : 'Tu nombre',
      'aria-label': pcName ? 'Nombre de la persona' : 'Tu nombre', autocomplete: pcName ? 'off' : 'given-name',
      dataset: { fkey: 'name' }, on: { change: (e) => { set({ name: cleanPersonName(e.target.value) }); savedToast(ctx, 'Guardado'); } },
    });
    const plan = h('input', {
      class: 'input input-inline input-name', value: s.planName || '', maxlength: '60', placeholder: sug || 'Ducuara Ana', 'aria-label': 'Cómo sale tu nombre en el plan',
      autocomplete: 'off', spellcheck: 'false', dataset: { fkey: 'planName' },
      on: { change: (e) => { set({ planName: cleanPersonName(e.target.value) }); savedToast(ctx, 'Guardado'); } },
    });
    return group(pcName ? 'Nombre de la persona' : 'Tu nombre', [
      row('Nombre', name, { icon: 'user' }),
      row('En el plan', plan, { icon: 'tag', sub: 'Como sale en la hoja del PC', cls: 'set-row-stack' }),
    ], { id: 'set-name', footer: pcName
      ? 'El de la persona de estos turnos (no el tuyo, si la ayudas). El nombre del plan (apellido y nombre) sirve para encontrar su fila en la hoja impresa del PC.'
      : 'El nombre del plan (apellido y nombre) sirve para encontrar tu fila en la hoja impresa del PC.' });
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
        const res = await shareOrDownload(`turnos-${toKey(ctx.now())}.json`, json, 'application/json');
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

  // Deshacer una importación o volver a una copia: si es de otro calendario, se vuelve a él entero
  function undo(key) {
    const msg = restoreCopy(ctx, key);
    if (msg) savedToast(ctx, msg); // null: segundo toque, ya no hay copia
  }

  // ---------- 5. Instalar ----------
  function install(state) {
    if (isStandalone()) return null;
    const plat = ctx.platform;
    if (plat !== 'ios') {
      // Android (y ordenador solo si Chrome lo ofrece): mismos datos en Chrome y en la app instalada
      const btn = installButton({ cls: 'btn-primary btn-lg btn-block', onDone: () => refresh() });
      if (plat === 'desktop' && !btn) return null;
      return h('section', { class: 'set-group', id: 'set-install' },
        h('h2', { class: 'set-title' }, 'Instalar en la pantalla de inicio'),
        h('div', { class: 'card set-card guide-card' },
          btn ? h('div', { class: 'install-cta' }, btn) : null,
          plat === 'android' ? [btn ? h('p', { class: 'hint install-or' }, 'O desde el menú de Chrome:') : null, androidInstallSteps()] : null,
          h('p', { class: 'hint' }, 'Tus turnos son los mismos en Chrome y en la app instalada.')));
    }
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
    // El enlace lleva la misma clave y token: vale desde cualquier dispositivo que ya leyó o publicó,
    // salvo si ahora mismo falla por la clave o el token (clave vieja, sin clave, token caducado o sin
    // permiso de escritura)
    const linkBlocked = LINK_BLOCKERS.includes(s.lastErrorCode);
    const canLink = s.enabled && isSyncKey(s.key) && Boolean(s.lastPushAt || s.lastPullAt) && !linkBlocked;

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
      h('p', { class: 'hint' }, `Un repositorio público solo para datos (no el de la app) y un token «fine-grained» con permiso Contents: Read and write solo en ese repositorio. Lo más fácil para la persona del teléfono: enviarle un enlace con «${ownLinkLabel(state)}».`),
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
          if (r.ok && r.private) ctx.toast('Ojo: el repositorio es privado. El calendario del teléfono solo puede suscribirse a uno público.', { type: 'error', duration: 8000 });
          if (r.ok && r.warning) ctx.toast(r.warning, { type: 'error', duration: 9000 });
        }, 'btn-secondary btn-sm'),
        actionButton('connect', 'Guardar y conectar', 'cloud', async () => {
          const cfg = formCfg();
          if (!cfg) { ctx.toast('Revisa los datos: usuario, repositorio, rama o token no válidos.', { type: 'error' }); return; }
          const ok = await runSetup(ctx, cfg, { confirm: false, helper: true });
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
            // Con el nombre: la confirmación dice «para Mauricio» y el core puede comprobar de quién es
            const st = store.get().settings;
            const link = buildSetupLink(location.href, { ...st.sync, name: publicName(st.name || '') });
            const ok = await copyText(link);
            ctx.toast(ok ? 'Enlace copiado. Lleva la clave y el token: envíalo solo a la persona de este calendario.' : 'No se pudo copiar', { type: ok ? 'ok' : 'error', duration: 8000 });
          } },
        }, icon('copy'), ownLinkLabel(state)) : null,
        linkBlocked && s.enabled ? h('p', { class: 'set-hint link-blocked', 'data-testid': 'make-link-blocked' },
          `«${ownLinkLabel(state)}» no está disponible hasta arreglar la conexión (${LINK_BLOCK_WHY[s.lastErrorCode]}). También se puede crear desde el teléfono que publica.`) : null,
        isConfigured(s) ? h('button', {
          class: 'btn btn-tinted btn-sm', type: 'button', 'data-testid': 'make-person-link', on: { click: () => openPersonLink() },
        }, icon('user'), 'Crear enlace para otra persona') : null,
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
      h('p', { class: 'hint' }, ctx.platform === 'android'
        ? 'Avisos como notificaciones con la app gratuita «ntfy», sin cuenta. En Android funciona muy bien y avisa al instante, también de los cambios de última hora.'
        : 'Avisos como notificaciones con la app gratuita «ntfy», sin cuenta. Útil para cambios de última hora.'),
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
            ['Instala la app gratuita ', h('b', {}, '«ntfy»'), ctx.platform === 'android' ? ' desde Google Play (o F-Droid).' : ctx.platform === 'ios' ? ' desde la App Store.' : ' en el teléfono (App Store o Google Play).'],
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
      copies.map((c) => {
        const info = copyInfo(state, c.key);
        // De otro calendario (antes de cambiar de persona o de borrar): se vuelve a él entero. Sin
        // conectar (nunca leyó ni publicó): vuelve a estar sin conectar
        const other = Boolean(info?.otherTarget);
        const connected = info?.connected !== false;
        const whose = !other ? '' : connected ? (info.name ? ` (calendario de ${info.name})` : '')
          : info.name ? ` (turnos de ${info.name}, sin conectar)` : ' (sin conectar)';
        return row(info?.switch ? 'Copia de antes de cambiar de calendario' : 'Copia de antes de importar', h('button', {
          class: 'btn btn-tinted btn-sm', type: 'button', 'data-testid': 'restore-copy',
          on: { click: async () => {
            const cur = store.get();
            const cs = cur.settings.sync;
            // Este dispositivo publica el calendario de ahora: al volver, ese calendario deja de actualizarse
            const publishing = other && cs.enabled && cs.deviceId && cs.publisher === cs.deviceId;
            const curName = publicName(cur.settings.name || '');
            const warn = publishing
              ? ` Ojo: este ${deviceWord()} actualiza ahora ${curName ? `el calendario de ${curName}` : 'el calendario de ahora'}: dejará de actualizarse hasta que otro dispositivo toque «Usar este dispositivo».`
              : '';
            const ok = await confirmDialog({
              title: '¿Volver a esta copia?', danger: true, ok: 'Volver a esta copia',
              text: other
                ? `Copia del ${dateTime(c.at)} con ${plural(c.days, 'día', 'días')}${whose}. ${connected
                  ? 'Este dispositivo vuelve a ese calendario y deja el de ahora.'
                  : 'Este dispositivo vuelve a como estaba (sin conectar) y deja el calendario de ahora.'}${warn}`
                : `Copia del ${dateTime(c.at)} con ${plural(c.days, 'día', 'días')}. Reemplaza los datos de este teléfono.`,
            });
            if (ok) undo(c.key);
          } },
        }, 'Recuperar'), { sub: `${dateTime(c.at)} · ${plural(c.days, 'día', 'días')}${whose}` });
      }));

    const dangerCard = h('div', { class: 'card set-card adv-card' },
      h('h3', { class: 'adv-title' }, 'Borrar'),
      row('Borrar todos los datos', h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-testid': 'wipe', on: { click: wipe } }, icon('trash'), 'Borrar'),
        { sub: 'Turnos, códigos y ajustes de este dispositivo. La copia de internet no se toca.' }));

    return h('details', { class: 'advanced', id: 'set-advanced', dataset: { fkey: 'advanced' }, 'data-testid': 'advanced' },
      h('summary', {}, h('span', { class: 'adv-sum-main' }, h('span', { class: 'adv-sum-title' }, 'Opciones avanzadas'), h('span', { class: 'adv-sum-sub' }, 'Para quien te ayuda con la app')), icon('chevronDown', 'icon chev')),
      h('div', { class: 'advanced-body' }, ghCard, placesCard, ntfyCard, restoreCard, dangerCard));
  }

  // ---------- Varias personas (SPEC §11) ----------
  // «Crear enlace para otra persona»: carpeta nueva y clave nueva en el mismo repositorio
  function openPersonLink() {
    const input = h('input', {
      class: 'input', maxlength: '60', placeholder: 'Ej.: Ana', autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'go',
      'aria-label': 'Nombre de la persona', 'data-testid': 'person-name', id: 'person-name-input',
    });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const result = h('div', { class: 'person-result', hidden: true, 'data-testid': 'person-result' });
    const form = h('div', { class: 'person-form' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, '¿Cómo se llama?'), input),
      err);
    let working = false, done = false;
    const createBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'person-create', on: { click: () => create() } },
      icon('link'), 'Crear enlace');
    const showErr = (m) => { err.textContent = m || ''; err.hidden = !m; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });

    async function create() {
      if (working) return;
      const name = cleanPersonName(input.value);
      if (!name) { showErr('Escribe el nombre de la persona.'); input.focus(); return; }
      working = true;
      createBtn.disabled = true;
      setChildren(createBtn, h('span', { class: 'spinner spinner-sm spinner-white', 'aria-hidden': 'true' }), 'Creando…');
      showErr('');
      const sync = store.get().settings.sync;
      let p = null;
      try {
        // Las carpetas que ya hay, para no repetir una (ana, ana-2…)
        const existing = (await listCalendars(sync)).map((c) => c.dir);
        p = buildPersonLink(location.href, sync, { name, existingDirs: existing });
      } catch (e) {
        showErr(e?.message || 'No se pudo crear el enlace. Comprueba la conexión.');
      } finally {
        working = false;
        createBtn.disabled = false;
        setChildren(createBtn, icon('link'), 'Crear enlace');
      }
      if (!p) return;
      done = true;
      const first = publicName(p.name);
      form.hidden = true;
      createBtn.hidden = true;
      result.hidden = false;
      const share = navigator.share && ctx.platform !== 'desktop' ? h('button', {
        class: 'btn btn-secondary btn-lg btn-block', type: 'button',
        on: { click: async () => { try { await navigator.share({ text: p.link }); } catch { /* cancelado */ } } },
      }, icon('share'), 'Compartir') : null;
      setChildren(result,
        h('div', { class: 'notice notice-ok' }, icon('check'), h('p', {}, h('b', {}, `Enlace para ${first} listo. `), `Sus turnos irán en la carpeta «${p.dir}».`)),
        h('button', {
          class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'person-copy',
          on: { click: async () => { const ok = await copyText(p.link); ctx.toast(ok ? 'Enlace copiado' : 'No se pudo copiar', { type: ok ? 'ok' : 'error' }); } },
        }, icon('copy'), 'Copiar el enlace'),
        share,
        h('code', { class: 'link-preview', 'data-testid': 'person-link' }, p.link),
        h('ol', { class: 'steps steps-compact' },
          h('li', {}, 'Envíaselo a ', h('b', {}, first), ' (por ejemplo, por WhatsApp). Lleva el token: envíalo solo a esa persona.'),
          h('li', {}, h('b', {}, 'En Android: '), 'lo abre en Chrome y toca «Sí, conectar».'),
          h('li', {}, h('b', {}, 'En iPhone: '), 'primero instala la app y después pega el enlace dentro (Ajustes → «Tengo un enlace»).')),
        h('p', { class: 'hint' }, `Si creas otro enlace para ${first} antes de que lo use, envía solo el último.`));
      footBtn.textContent = 'Listo';
      family.at = 0; // la lista de calendarios cambiará cuando lo use
    }

    const footBtn = h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', on: { click: () => sheet.close() } }, 'Cancelar');
    const sheet = openSheet({
      title: 'Enlace para otra persona',
      subtitle: 'Por ejemplo, para tu hermana o tu hermano',
      className: 'sheet-person',
      body: h('div', { class: 'paste-setup' },
        h('p', { class: 'install-why' }, 'Cada persona tiene sus propios turnos y su calendario, con el mismo repositorio y el mismo token: no hace falta crear nada en GitHub.'),
        form, createBtn, result),
      footer: footBtn,
      isDirty: () => !done && input.value.trim().length > 0,
      dirtyText: 'No se creará el enlace.',
    });
    setTimeout(() => input.focus({ preventScroll: true }), 350);
    return sheet;
  }

  // «Calendarios de la familia»: las carpetas del repo de datos (se lee al abrir Ajustes; caché local)
  const FAMILY_KEY = 'turnos-mauricio:family';
  const family = { key: '', at: 0, list: null, loading: false };
  try {
    const c = JSON.parse(ls?.getItem(FAMILY_KEY) || 'null');
    if (c && Array.isArray(c.list)) Object.assign(family, { key: c.key, list: c.list });
  } catch { /* caché dañada: se vuelve a leer */ }
  const familyKey = (s) => `${s.owner}/${s.repo}/${s.branch || ''}/${s.token ? s.token.slice(-6) : ''}`;

  async function loadFamily({ force = false } = {}) {
    const s = store.get().settings.sync;
    if (!(s.enabled && isConfigured(s)) || family.loading) return;
    const key = familyKey(s);
    if (!force && family.key === key && Date.now() - family.at < 10 * 60 * 1000) return;
    family.loading = true;
    try {
      const list = await listCalendars(s);
      Object.assign(family, { key, list });
      try { ls?.setItem(FAMILY_KEY, JSON.stringify({ key, list })); } catch { /* sin espacio */ }
    } catch (e) {
      if (family.key !== key) family.list = null; // de otra conexión: no se muestra
      console.warn('[familia]', e?.code || '', e?.message || e);
    } finally {
      family.loading = false;
      family.at = Date.now();
      family.key = key;
    }
    if (el.isConnected && !el.hidden) refresh();
  }

  function familyGroup(state) {
    const s = state.settings.sync;
    if (!(s.enabled && isConfigured(s)) || family.key !== familyKey(s) || !family.list || family.list.length < 2) return null;
    const plat = ctx.platform;
    const items = family.list.map((c) => {
      const label = c.name || (c.dir ? c.dir : 'Calendario principal');
      const mine = c.dir === (s.dir || '');
      const sub = mine ? 'Tu calendario' : c.updatedAt ? `Actualizado ${ago(c.updatedAt, ctx.now())}` : '';
      let action = null;
      if (!mine) {
        // iPhone: primero el aviso «deja ACTIVADO Eliminar alertas» (la suscripción se abre desde él)
        action = h('button', {
          class: 'btn btn-tinted btn-sm fam-btn', type: 'button', 'data-testid': 'family-subscribe',
          on: { click: () => openFamilyCalendar(ctx, { ...c, label }) },
        }, icon('calendar'), 'Ver sus turnos en mi calendario');
      }
      return h('div', { class: ['fam-item', mine && 'is-mine'], dataset: { dir: c.dir || '_' }, 'data-testid': 'family-item' },
        h('span', { class: 'fam-avatar', 'aria-hidden': 'true' }, (label[0] || '?').toUpperCase()),
        h('span', { class: 'set-row-main' }, h('span', { class: 'set-label' }, label), sub ? h('span', { class: 'set-sub' }, sub) : null),
        mine ? h('span', { class: 'pill pill-ok' }, 'Tú') : null,
        action);
    });
    return group('Calendarios de la familia', items, {
      id: 'set-family', cls: 'set-family',
      footer: plat === 'ios'
        ? 'Para mirar sus turnos (por ejemplo, para cambiar uno). Al suscribirte, deja activado «Eliminar alertas»: así no te llegan sus avisos.'
        : 'Para mirar sus turnos (por ejemplo, para cambiar uno), sin recibir sus avisos.',
    });
  }

  async function wipe() {
    const ok1 = await confirmDialog({
      icon: '🗑️', title: '¿Borrar todos los datos?', danger: true,
      text: 'Se borran tus turnos, códigos y ajustes de este dispositivo (también la conexión del calendario). La copia de internet no se toca.',
      ok: 'Continuar', cancel: 'Cancelar',
    });
    if (!ok1) return;
    const ok2 = await confirmDialog({ title: '¿Lo confirmas?', text: 'Este dispositivo se quedará vacío, como recién instalado.', ok: 'Sí, borrar todo', cancel: 'No, cancelar', danger: true });
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
      row('Turnos', h('span', { class: 'muted' }, `v${ctx.version}`), { icon: 'heart' }),
      h('p', { class: 'set-note' }, h('b', {}, 'Tus datos: '),
        'se guardan en este teléfono. Si conectas el calendario, tus horarios se publican en internet: quien tenga el enlace puede verlos (sin notas; los lugares, solo si se activa). La copia completa va cifrada.'),
      h('button', { class: 'set-row set-row-btn', type: 'button', on: { click: () => showOnboarding(ctx, { again: true }) } },
        h('span', { class: 'set-icon si-sparkles', 'aria-hidden': 'true' }, icon('sparkles')),
        h('span', { class: 'set-row-main' }, h('span', { class: 'set-label' }, 'Ver la bienvenida otra vez')),
        h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, icon('chevronRight'))),
    ], { id: 'set-about' });
  }

  function render(state) {
    loadFamily(); // en segundo plano (solo si está conectado y la lista es vieja)
    setChildren(el,
      h('header', { class: 'page-head' }, h('h1', { class: 'large-title' }, 'Ajustes')),
      banners(ctx, state, 'ajustes'),
      calendar(state),
      familyGroup(state),
      codes(state),
      contract(state),
      reminders(state),
      names(state),
      backup(),
      install(state),
      advanced(state),
      about(),
    );
  }

  function scrollToSection(section) {
    requestAnimationFrame(() => {
      const target = document.getElementById(`set-${section}`);
      // Abre lo plegado que lo contiene (Opciones avanzadas) y la propia sección si es plegable
      for (let d = target; d && d !== el; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true;
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
