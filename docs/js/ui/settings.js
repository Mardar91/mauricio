// Pestaña "Ajustes": perfil, códigos, recordatorios, calendario del iPhone, ntfy, copias, instalación.
import {
  buildICS, buildSetupLink, calendarUrls, exportBackup, importBackup, pullBackup, randomTopic, testConnection,
  testNtfy, toKey, updateSettings, formatHours, hasTime,
} from '../core/index.js';
import { badgeFromDef, displayName, groupCodes, timeRange } from './badge.js';
import { ago, minutesText, copyText, dateTime, fmtNum, h, isIOS, isStandalone, parseNum, shareOrDownload, setChildren } from './dom.js';
import { icon, shareIcon } from './icons.js';
import { confirmDialog } from './sheet.js';
import { unconfirmedInUse } from './attention.js';
import { showOnboarding } from './onboarding.js';
import { openPasteSetup } from './setup.js';

const MINUTES = [15, 30, 45, 60, 90, 120];

export function createSettings(ctx) {
  const { store } = ctx;
  const el = h('section', { 'aria-label': 'Ajustes' });
  const busy = {}; // botones en curso
  let showToken = false;
  let pendingCode = null;

  const set = (patch) => store.set((s) => updateSettings(s, patch));

  // ---------- Piezas ----------
  const group = (title, rows, { footer, id, cls } = {}) => h('section', { class: ['set-group', cls], id },
    title ? h('h2', { class: 'set-title' }, title) : null,
    h('div', { class: 'card set-card' }, rows),
    footer ? h('p', { class: 'set-footer' }, footer) : null);

  const row = (label, control, { sub, icon: ic, cls } = {}) => h('div', { class: ['set-row', cls] },
    ic ? h('span', { class: ['set-icon', `si-${ic}`], 'aria-hidden': 'true' }, icon(ic)) : null,
    h('div', { class: 'set-row-main' }, h('span', { class: 'set-label' }, label), sub ? h('span', { class: 'set-sub' }, sub) : null),
    control);

  function toggle(fkey, checked, onChange, label) {
    return h('input', { type: 'checkbox', class: 'switch', checked, 'aria-label': label, dataset: { fkey }, on: { change: (e) => onChange(e.target.checked) } });
  }

  function actionButton(id, label, ic, run, cls = 'btn-secondary') {
    return h('button', {
      class: ['btn', cls, busy[id] && 'is-busy'], type: 'button', disabled: Boolean(busy[id]), dataset: { fkey: `btn-${id}` },
      on: { click: async () => {
        busy[id] = true; refresh();
        try { await run(); } finally { busy[id] = false; refresh(); }
      } },
    }, busy[id] ? h('span', { class: 'spinner spinner-sm' }) : (ic ? icon(ic) : null), label);
  }

  // Re-pinta conservando el foco del botón pulsado (lectores de pantalla)
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

  // ---------- Secciones ----------
  function profile(s) {
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
        ctx.toast(`Contrato: ${fmtNum(n)} h por semana`, { type: 'ok' });
      } },
    });
    const daily = (Number(s.weeklyHours) || 35) / (Number(s.workDaysPerWeek) || 5);
    return group('Tú', [
      row('Nombre', name, { icon: 'user' }),
      row('Horas de contrato', h('span', { class: 'inline-unit' }, hours, h('span', { class: 'unit' }, 'h/sem')), { icon: 'clock', sub: `${formatHours(daily * 60)} por día laborable (lun–vie)` }),
    ]);
  }

  function codes(state) {
    const unconf = unconfirmedInUse(state, ctx.now());
    const groups = groupCodes(state);
    const codeRow = (def) => {
      const u = def.confirmed === false && ['shift', 'event', 'other'].includes(def.kind);
      const used = unconf.get(def.code);
      return h('button', {
        class: ['set-row', 'code-row', u && 'unconfirmed'], type: 'button', dataset: { code: def.code, fkey: `code-${def.code}` },
        'aria-label': `${def.code === '-' ? 'Libre' : def.code}: ${def.name}${hasTime(def) ? `, ${timeRange(def)}` : ''}${u ? ', horario sin confirmar' : ''}`,
        on: { click: () => ctx.openCode(def.code) },
      },
      h('span', { class: 'code-badge' }, badgeFromDef(def, { title: false })),
      h('span', { class: 'set-row-main' },
        h('span', { class: 'set-label' }, displayName(def)),
        h('span', { class: 'set-sub' }, [timeRange(def), !u && def.breakMin && hasTime(def) ? `pausa ${def.breakMin} min` : '', def.kind !== 'place' ? def.place : ''].filter(Boolean).join(' · ') || ' ')),
      u ? h('span', { class: 'pill pill-warn' }, used?.next ? 'Confirmar' : 'Sin confirmar') : null,
      h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, icon('chevronRight')));
    };
    // Lugares: fichas compactas (insignia + dirección si la tiene)
    const placeChip = (def) => h('button', {
      class: 'place-chip', type: 'button', dataset: { code: def.code, fkey: `code-${def.code}` },
      'aria-label': `Lugar ${def.code}${def.place ? `: ${def.place}` : ''}`, on: { click: () => ctx.openCode(def.code) },
    }, badgeFromDef(def, { title: false }), def.place ? h('span', { class: 'place-chip-text' }, def.place) : null);
    const pending = groups.flatMap((g) => g.codes).filter((d) => d.confirmed === false && unconf.get(d.code)?.next);
    return h('section', { class: 'set-group', id: 'set-codes' },
      h('h2', { class: 'set-title' }, 'Códigos y horarios'),
      pending.length ? h('div', { class: 'notice notice-warn' }, icon('warning'), h('p', {},
        h('b', {}, pending.length === 1 ? `Confirma el horario de ${pending[0].code}. ` : `Confirma los horarios de ${pending.map((d) => d.code).join(', ')}. `),
        'La app los ha supuesto; tócalos para revisarlos.')) : null,
      ...groups.map((g) => h('div', { class: 'card set-card codes-card' },
        h('h3', { class: 'set-subtitle' }, g.title),
        g.id === 'place' ? h('div', { class: 'place-chips' }, g.codes.map(placeChip)) : g.codes.map(codeRow))),
      h('button', { class: 'btn btn-secondary btn-block', type: 'button', on: { click: () => ctx.openCode(null) } }, icon('plus'), 'Añadir código'),
      h('p', { class: 'set-footer' }, 'Toca un código para cambiar su horario, pausa o lugar. La pausa se descuenta de las horas; los lugares no suman horas.'));
  }

  function reminders(state) {
    const r = state.settings.reminders;
    const via = [state.settings.sync.enabled && 'Calendario del iPhone', state.settings.ntfy.enabled && 'ntfy'].filter(Boolean);
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
      row('La víspera', toggle('eve', r.eveningBefore, (v) => set({ reminders: { eveningBefore: v } }), 'Aviso la víspera'), { icon: 'bell', sub: 'Un aviso la tarde anterior' }),
      row('Hora', time, { cls: 'set-row-sub' }),
      row('Antes del turno', toggle('pre', r.beforeStart, (v) => set({ reminders: { beforeStart: v } }), 'Aviso antes del turno'), { icon: 'clock', sub: 'Un aviso poco antes de empezar' }),
      row('Cuándo', mins, { cls: 'set-row-sub' }),
    ], {
      footer: via.length ? `✅ Los avisos te llegan por: ${via.join(' y ')}.`
        : '⚠️ Para recibir los avisos, activa abajo el Calendario del iPhone o ntfy.',
    });
  }

  function calendar(state) {
    const s = state.settings.sync;
    const configured = Boolean(s.owner && s.repo && s.token);
    const urls = s.owner && s.repo ? calendarUrls(s) : null;
    let status, statusCls;
    if (!s.enabled) { status = configured ? 'Desactivado' : 'Sin configurar'; statusCls = 'pill-muted'; }
    else if (s.lastError) { status = 'Con problemas'; statusCls = 'pill-alert'; }
    else if (s.lastPushAt) { status = 'Funcionando'; statusCls = 'pill-ok'; }
    else { status = 'Pendiente'; statusCls = 'pill-warn'; }

    const owner = h('input', { class: 'input', value: s.owner || '', placeholder: 'usuario', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Usuario de GitHub', dataset: { fkey: 'owner' }, on: { change: (e) => set({ sync: { owner: e.target.value.trim(), lastError: null, lastPushHash: null } }) } });
    const repo = h('input', { class: 'input', value: s.repo || '', placeholder: 'repositorio', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Repositorio', dataset: { fkey: 'repo' }, on: { change: (e) => set({ sync: { repo: e.target.value.trim(), lastError: null, lastPushHash: null } }) } });
    const token = h('input', {
      class: 'input input-token', type: showToken ? 'text' : 'password', value: s.token || '', placeholder: 'github_pat_…', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Token de GitHub', dataset: { fkey: 'token' }, on: { change: (e) => set({ sync: { token: e.target.value.trim(), lastError: null, lastPushHash: null } }) },
    });
    const eye = h('button', { class: 'icon-btn', type: 'button', 'aria-label': showToken ? 'Ocultar token' : 'Mostrar token', dataset: { fkey: 'eye' }, on: { click: () => { showToken = !showToken; refresh(); } } }, icon(showToken ? 'eyeOff' : 'eye'));

    const subscribe = urls ? h('a', {
      class: ['btn', 'btn-primary', 'btn-lg', 'btn-block', !(s.enabled && configured) && 'is-disabled'],
      href: urls.webcal, 'aria-disabled': s.enabled && configured ? 'false' : 'true', dataset: { testid: 'webcal' },
      on: { click: (e) => { if (!(s.enabled && configured)) { e.preventDefault(); ctx.toast('Primero activa y configura la sincronización.', { type: 'error' }); } } },
    }, icon('calendar'), 'Suscribir en el iPhone') : null;

    return h('section', { class: 'set-group', id: 'set-calendar' },
      h('h2', { class: 'set-title' }, 'Calendario del iPhone'),
      h('div', { class: 'card set-card' },
        h('div', { class: 'set-intro' },
          h('span', { class: 'set-intro-icon', 'aria-hidden': 'true' }, '📅'),
          h('p', {}, 'Tus turnos aparecen en la app Calendario del iPhone, con avisos, y se actualizan solos.')),
        row('Estado', h('span', { class: ['pill', statusCls], dataset: { testid: 'sync-status' } }, status), {
          icon: 'cloud',
          sub: s.lastError ? s.lastError : s.lastPushAt ? `Último envío: ${ago(s.lastPushAt, ctx.now())}` : configured ? 'Aún no se ha enviado nada' : 'Necesita el enlace de configuración',
          cls: s.lastError ? 'has-error' : '',
        }),
        row('Publicar mis turnos', toggle('syncEnabled', Boolean(s.enabled), (v) => {
          set({ sync: { enabled: v, lastError: null } });
          if (v && configured) ctx.background?.syncNow({ manual: true });
        }, 'Publicar mis turnos en el calendario'), { icon: 'refresh' }),
        h('div', { class: 'set-actions' },
          !configured ? h('button', { class: 'btn btn-primary btn-block', type: 'button', 'data-testid': 'setup-paste-open', on: { click: () => openPasteSetup(ctx) } }, icon('link'), 'Tengo un enlace de configuración') : null,
          configured ? subscribe : null,
          s.enabled && configured ? actionButton('push', 'Enviar ahora', 'upload', async () => {
            const r = await ctx.background.syncNow({ manual: true, force: true });
            ctx.toast(r?.message || 'Listo', { type: r?.ok ? 'ok' : 'error' });
          }) : null)),
      details('guide-cal', 'Cómo suscribirte (paso a paso)',
        steps(
          ['Toca ', h('b', {}, '«Suscribir en el iPhone»'), '.'],
          ['El iPhone pregunta si quieres suscribirte: toca ', h('b', {}, '«Suscribirse»'), '.'],
          ['Si quieres, cambia el nombre a «Turnos» y elige el color naranja.'],
          [h('b', {}, 'Muy importante: '), 'desactiva ', h('b', {}, '«Eliminar alertas»'), ' («Remove Alerts»). Si no, el iPhone borra los avisos de tus turnos.'],
          ['Toca ', h('b', {}, '«OK»'), '. En unos minutos verás tus turnos en la app Calendario.']),
        h('p', { class: 'hint' }, 'Otra forma: Ajustes del iPhone → Calendario → Cuentas → Añadir cuenta → Otra → «Añadir calendario suscrito», y pega este enlace:'),
        urls ? h('div', { class: 'copy-line' },
          h('code', {}, urls.https),
          h('button', { class: 'btn btn-tinted btn-sm', type: 'button', on: { click: async () => ctx.toast(await copyText(urls.https) ? 'Enlace copiado' : 'No se pudo copiar', { type: 'ok' }) } }, icon('copy'), 'Copiar')) : null,
        h('p', { class: 'hint' }, 'El calendario se actualiza solo (más o menos cada hora). Si cambias un turno aquí, aparece allí al rato.')),
      details('setup-cal', 'Configuración (para quien te ayuda)',
        h('p', { class: 'hint' }, 'Se necesita un repositorio público de GitHub y un token «fine-grained» con permiso Contents: Read and write solo en ese repositorio. Lo más fácil: enviar a este teléfono un enlace de configuración.'),
        h('div', { class: 'field-row' },
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Usuario'), owner),
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Repositorio'), repo)),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Token'), h('div', { class: 'input-with-btn' }, token, eye)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-secondary', type: 'button', on: { click: () => openPasteSetup(ctx) } }, icon('link'), 'Pegar enlace'),
          actionButton('test', 'Probar conexión', 'link', async () => {
            const r = await testConnection(store.get().settings.sync);
            ctx.toast(r.message, { type: r.ok ? 'ok' : 'error', duration: 6000 });
            if (r.ok && r.private) ctx.toast('Ojo: el repositorio es privado. El iPhone solo puede suscribirse a uno público.', { type: 'error', duration: 8000 });
          }),
          configured ? h('button', {
            class: 'btn btn-secondary', type: 'button',
            on: { click: async () => {
              const link = buildSetupLink(location.href, store.get().settings.sync);
              const ok = await copyText(link);
              ctx.toast(ok ? 'Enlace de configuración copiado. ¡Contiene el token: envíalo solo a Mauricio!' : 'No se pudo copiar', { type: ok ? 'ok' : 'error', duration: 7000 });
            } },
          }, icon('copy'), 'Copiar enlace de configuración') : null)),
      h('div', { class: 'card set-card' },
        row('Archivo .ics', actionButton('ics', 'Exportar', 'share', async () => {
          const res = await shareOrDownload('turnos.ics', buildICS(store.get(), { now: ctx.now() }), 'text/calendar');
          if (res === 'downloaded') ctx.toast('Archivo turnos.ics descargado', { type: 'ok' });
        }, 'btn-tinted btn-sm'), { icon: 'download', sub: 'Para importar una vez (no se actualiza)' })));
  }

  function ntfy(state) {
    const n = state.settings.ntfy;
    const next = Object.entries(n.scheduled || {}).filter(([k, v]) => k !== 'turnos-keepalive' && new Date(v.at) > ctx.now())
      .map(([, v]) => new Date(v.at)).sort((a, b) => a - b)[0];
    const topicInput = h('input', {
      class: 'input input-mono', value: n.topic || '', placeholder: 'turnos-mauricio-…', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Tema de ntfy', dataset: { fkey: 'topic' }, on: { change: (e) => set({ ntfy: { topic: e.target.value.trim().replace(/\s+/g, '-'), lastError: null } }) },
    });
    const server = h('input', { class: 'input', value: n.server || 'https://ntfy.sh', 'aria-label': 'Servidor de ntfy', autocapitalize: 'off', spellcheck: 'false', dataset: { fkey: 'ntfyServer' }, on: { change: (e) => set({ ntfy: { server: e.target.value.trim() || 'https://ntfy.sh' } }) } });
    let status;
    if (!n.enabled) status = h('span', { class: 'pill pill-muted' }, 'Desactivado');
    else if (n.lastError) status = h('span', { class: 'pill pill-alert' }, 'Con problemas');
    else status = h('span', { class: 'pill pill-ok' }, 'Activado');
    return h('section', { class: 'set-group', id: 'set-ntfy' },
      h('h2', { class: 'set-title' }, 'Notificaciones con ntfy'),
      h('div', { class: 'card set-card' },
        h('div', { class: 'set-intro' },
          h('span', { class: 'set-intro-icon', 'aria-hidden': 'true' }, '🔔'),
          h('p', {}, 'Opcional: avisos como notificaciones con la app gratuita «ntfy». No necesitas cuenta.')),
        row('Usar ntfy', toggle('ntfyEnabled', Boolean(n.enabled), (v) => {
          const patch = { ntfy: { enabled: v, lastError: null } };
          if (v && !store.get().settings.ntfy.topic) patch.ntfy.topic = randomTopic();
          set(patch);
          ctx.background?.ntfyNow({ manual: true });
        }, 'Usar ntfy'), { icon: 'bell' }),
        row('Estado', status, { sub: n.lastError || (n.enabled ? (next ? `Próximo aviso: ${dateTime(next.toISOString())}` : 'No hay avisos en los próximos 3 días') : ''), cls: n.lastError ? 'has-error' : '' }),
        h('div', { class: 'set-block' },
          h('span', { class: 'label' }, 'Tu tema (como una contraseña: no lo compartas)'),
          h('div', { class: 'input-with-btn' }, topicInput,
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copiar tema', on: { click: async () => ctx.toast(await copyText(store.get().settings.ntfy.topic) ? 'Tema copiado' : 'No se pudo copiar', { type: 'ok' }) } }, icon('copy'))),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-secondary btn-sm', type: 'button', on: { click: async () => {
              if (store.get().settings.ntfy.topic) {
                const ok = await confirmDialog({ title: '¿Crear un tema nuevo?', text: 'Tendrás que suscribirte otra vez en la app ntfy con el tema nuevo.', ok: 'Crear nuevo' });
                if (!ok) return;
              }
              set({ ntfy: { topic: randomTopic(), lastError: null } });
            } } }, icon('refresh'), 'Generar tema'),
            actionButton('ntfyTest', 'Enviar prueba', 'bell', async () => {
              const r = await testNtfy(store.get().settings.ntfy);
              ctx.toast(r.message, { type: r.ok ? 'ok' : 'error', duration: 6000 });
            }, 'btn-tinted btn-sm')))),
      details('guide-ntfy', 'Cómo activarlo (paso a paso)',
        steps(
          ['Instala la app gratuita ', h('b', {}, '«ntfy»'), ' desde la App Store.'],
          ['Ábrela y toca el botón ', h('b', {}, '«+»'), ' (arriba).'],
          ['Escribe tu tema: ', h('code', { class: 'topic-code' }, n.topic || '(pulsa «Generar tema»)'), '.'],
          ['Toca ', h('b', {}, '«Subscribe»'), ' y permite las notificaciones.'],
          ['Vuelve aquí y toca ', h('b', {}, '«Enviar prueba»'), '. ¡Te debería llegar un aviso!']),
        h('p', { class: 'hint' }, 'ntfy programa los avisos con hasta 3 días de antelación. Abre Turnos de vez en cuando para que siempre estén al día (te lo recordaremos).'),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Servidor (avanzado)'), server)));
  }

  function backup(state) {
    const s = state.settings.sync;
    const fileInput = h('input', {
      type: 'file', accept: 'application/json,.json', class: 'visually-hidden', tabindex: '-1', 'data-testid': 'import-file',
      on: { change: async () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (f) await importText(await f.text());
      } },
    });
    return group('Copia de seguridad', [
      row('Exportar copia', actionButton('export', 'Exportar', 'share', async () => {
        const json = exportBackup(store.get(), { now: ctx.now() });
        const res = await shareOrDownload(`turnos-mauricio-${toKey(ctx.now())}.json`, json, 'application/json');
        if (res === 'downloaded') ctx.toast('Copia descargada', { type: 'ok' });
      }, 'btn-tinted btn-sm'), { icon: 'download', sub: 'Turnos y ajustes en un archivo' }),
      row('Importar copia', h('label', { class: 'btn btn-tinted btn-sm', role: 'button', tabindex: '0', on: { keydown: (e) => { if (e.key === 'Enter') fileInput.click(); } } }, icon('upload'), 'Importar', fileInput),
        { icon: 'upload', sub: 'Reemplaza los datos actuales' }),
      s.owner && s.repo && s.token ? row('Restaurar desde GitHub', actionButton('pull', 'Restaurar', 'cloud', async () => {
        try {
          const json = await pullBackup(store.get().settings.sync);
          await importText(json, 'GitHub');
        } catch (e) {
          ctx.toast(e.message || 'No se pudo descargar la copia.', { type: 'error' });
        }
      }, 'btn-tinted btn-sm'), { icon: 'cloud', sub: 'La última copia enviada' }) : null,
    ]);
  }

  async function importText(text, from = 'el archivo') {
    let next;
    try {
      next = importBackup(store.get(), text, { now: ctx.now() });
    } catch (e) {
      ctx.toast(e.message, { type: 'error', duration: 6000 });
      return;
    }
    const n = Object.keys(next.days).length;
    const ok = await confirmDialog({
      icon: '📥', title: '¿Restaurar la copia?',
      text: `La copia de ${from} tiene ${n} ${n === 1 ? 'día' : 'días'} con turnos. Reemplazará los datos de este teléfono.`,
      ok: 'Restaurar', cancel: 'Cancelar',
    });
    if (!ok) return;
    store.set(() => next);
    ctx.toast(`Copia restaurada: ${n} días`, { type: 'ok' });
  }

  function install() {
    if (isStandalone()) {
      return group('Pantalla de inicio', [row('Instalada', h('span', { class: 'pill pill-ok' }, '✓'), { icon: 'phone', sub: 'La app ya está en tu pantalla de inicio.' })]);
    }
    return h('section', { class: 'set-group', id: 'set-install' },
      h('h2', { class: 'set-title' }, 'Añadir a pantalla de inicio'),
      h('div', { class: 'card set-card guide-card' },
        steps(
          [isIOS() ? 'Abre esta página en ' : 'En el iPhone, abre esta página en ', h('b', {}, 'Safari'), '.'],
          ['Toca el botón ', h('b', {}, 'Compartir'), ' ', shareIcon(), ' (abajo en la pantalla).'],
          ['Desliza hacia abajo y toca ', h('b', {}, '«Añadir a pantalla de inicio»'), ' ', icon('addSquare', 'icon icon-inline')],
          ['Toca ', h('b', {}, '«Añadir»'), '. Ya tienes el icono naranja «Turnos».']),
        h('p', { class: 'hint' }, 'Importante: los datos de Safari y los de la app instalada están separados. Usa siempre el icono de la pantalla de inicio.')));
  }

  function about() {
    return group('Acerca de', [
      row('Turnos de Mauricio', h('span', { class: 'muted' }, `v${ctx.version}`), { icon: 'heart', sub: 'Tus datos se guardan solo en este teléfono (y en tu GitHub si activas el calendario).' }),
      h('button', { class: 'set-row set-row-btn', type: 'button', on: { click: () => showOnboarding(ctx, { again: true }) } },
        h('span', { class: 'set-icon si-sparkles', 'aria-hidden': 'true' }, icon('sparkles')),
        h('span', { class: 'set-row-main' }, h('span', { class: 'set-label' }, 'Ver la bienvenida otra vez')),
        h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, icon('chevronRight'))),
    ]);
  }

  function render(state) {
    const s = state.settings;
    setChildren(el, 
      h('header', { class: 'page-head' }, h('h1', { class: 'large-title' }, 'Ajustes')),
      profile(s),
      codes(state),
      reminders(state),
      calendar(state),
      ntfy(state),
      backup(state),
      install(),
      about(),
    );
  }

  return {
    el,
    render,
    onShow(opts) {
      if (opts?.code) {
        pendingCode = opts.code;
        requestAnimationFrame(() => {
          document.getElementById('set-codes')?.scrollIntoView({ block: 'start' });
          const c = pendingCode;
          pendingCode = null;
          if (c && store.get().codes[c]) ctx.openCode(c);
        });
        return true;
      }
      return false;
    },
  };
}
