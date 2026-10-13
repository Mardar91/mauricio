// Pestaña "Hoy": próximo turno, semana actual, próximos días y consejos.
import {
  addDays, formatHours, formatLong, getAdvice, getCode, isoWeek, weekStart, weekSummary, weekdayShort,
} from '../core/index.js';
import { badge, badgeRow, displayName, workText } from './badge.js';
import { cap, h, setChildren } from './dom.js';
import { icon } from './icons.js';
import { countdown, dayLabel, daySummary, nextShift, remaining } from './shifts.js';

export function adviceCard(ctx, a) {
  return h('article', { class: ['advice', `advice-${a.level}`] },
    h('span', { class: 'advice-icon', 'aria-hidden': 'true' }, a.icon),
    h('div', { class: 'advice-body' },
      h('h3', { class: 'advice-title' }, a.title),
      h('p', { class: 'advice-text' }, a.text),
      a.action ? h('button', {
        class: 'btn btn-tinted btn-sm', type: 'button',
        on: { click: () => ctx.go(a.action.tab, a.code ? { code: a.code } : undefined) },
      }, a.action.label) : null));
}

const DOW = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

export function createToday(ctx) {
  const el = h('section', { 'aria-label': 'Hoy' });

  function hero(state, now, today) {
    const next = nextShift(state, now);
    if (!next) {
      return h('article', { class: 'card hero hero-none' },
        h('p', { class: 'hero-kicker' }, 'Próximo turno'),
        h('p', { class: 'hero-empty-title' }, 'No hay más turnos en tu plan'),
        h('p', { class: 'muted' }, 'Cuando tengas el plan del próximo mes, hazle una foto.'),
        h('button', { class: 'btn btn-primary', type: 'button', on: { click: () => ctx.go('escanear') } },
          icon('camera'), 'Escanear el plan'));
    }
    const { item, key, current } = next;
    const def = item.def;
    const places = item.places;
    const facts = [
      h('div', { class: 'fact' }, icon('clock'), h('span', {}, h('b', {}, `${def.start} – ${def.end}`), item.end.getDate() !== item.start.getDate() ? ' (termina al día siguiente)' : '')),
      h('div', { class: 'fact' }, icon('hours'), h('span', {}, workText(def))),
    ];
    if (places.length) {
      facts.push(h('div', { class: 'fact' }, icon('pin'), h('span', { class: 'fact-place' },
        places.map((p) => [badge(state, p.code, { size: 'sm' }), ' ', displayName(p)]))));
    }
    const note = state.days[key]?.note;
    if (note) facts.push(h('div', { class: 'fact' }, icon('note'), h('span', {}, note)));
    const others = (state.days[key]?.codes || []).filter((c) => c !== def.code && getCode(state, c).kind === 'event');
    if (others.length) facts.push(h('div', { class: 'fact' }, icon('user'), h('span', {}, others.map((c) => getCode(state, c).name).join(', '))));

    let top, progress = null;
    if (current) {
      const total = item.end - item.start, done = now - item.start;
      const pct = Math.min(100, Math.max(0, (done / total) * 100));
      top = h('div', { class: 'hero-top' },
        h('span', { class: 'hero-kicker live' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), 'Trabajando ahora'),
        h('span', { class: 'chip chip-live' }, `hasta las ${def.end}`));
      progress = h('div', { class: 'hero-progress' },
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'Turno completado' },
          h('div', { class: 'progress-fill', style: { width: `${pct}%` } })),
        h('p', { class: 'hero-progress-text' }, `Quedan ${remaining(item.end - now)} · ¡ánimo!`));
    } else {
      top = h('div', { class: 'hero-top' },
        h('span', { class: 'hero-kicker' }, 'Próximo turno'),
        h('span', { class: 'chip chip-countdown' }, `empieza ${countdown(item.start - now, item.start, now)}`));
    }
    return h('article', {
      class: ['card', 'hero', current && 'hero-current'], style: { '--c': def.color },
      tabindex: '0', role: 'button', 'aria-label': `${current ? 'Trabajando ahora' : 'Próximo turno'}: ${def.name}, ${dayLabel(key, today)}, de ${def.start} a ${def.end}`,
      on: { click: (e) => { if (!e.target.closest('button')) ctx.openDay(key); }, keydown: (e) => { if (e.key === 'Enter') ctx.openDay(key); } },
    },
    top,
    h('div', { class: 'hero-main' },
      badge(state, def.code, { size: 'xl' }),
      h('div', { class: 'hero-titles' },
        h('p', { class: 'hero-name' }, def.name),
        h('p', { class: 'hero-when' }, dayLabel(key, today)))),
    progress,
    h('div', { class: 'hero-facts' }, facts));
  }

  function todayLine(state, today, now) {
    const s = daySummary(state, today);
    const next = nextShift(state, now);
    if (next && next.key === today) return null; // ya lo dice la tarjeta
    if (next?.current) return null;
    if (!s.known) return s.holiday ? h('p', { class: 'today-line' }, `🎉 Hoy es festivo: ${s.holiday}`) : null;
    const kinds = s.codes.map((c) => getCode(state, c).kind);
    let text = null;
    if (kinds.includes('vacation')) text = '🏖️ Hoy estás de vacaciones. ¡Disfruta!';
    else if (kinds.includes('sick')) text = '🤒 Hoy estás de baja. Cuídate mucho.';
    else if (kinds.includes('wish') || kinds.includes('off') || !s.codes.length) text = '🌿 Hoy tienes el día libre.';
    else if (s.holiday) text = `🎉 Hoy es festivo: ${s.holiday}`;
    return text ? h('p', { class: 'today-line' }, text) : null;
  }

  function weekCard(state, today) {
    const monday = weekStart(today);
    const w = weekSummary(state, monday);
    const pct = w.soll ? Math.min(100, (w.total / w.soll) * 100) : 0;
    const over = w.total > w.soll;
    const diff = w.total - w.soll;
    let msg;
    if (!w.known) msg = 'Todavía no hay turnos cargados para esta semana.';
    else if (Math.abs(diff) < 15) msg = 'Justo lo de tu contrato. 👌';
    else if (over) msg = `${formatHours(diff)} más que tu contrato.`;
    else msg = `Faltan ${formatHours(-diff)} para llegar a ${formatHours(w.soll)}.`;
    return h('article', {
      class: 'card week-card', role: 'button', tabindex: '0', 'aria-label': 'Ver esta semana en el calendario',
      on: { click: () => ctx.go('calendario', { key: today }), keydown: (e) => { if (e.key === 'Enter') ctx.go('calendario', { key: today }); } },
    },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title' }, 'Esta semana'),
      h('span', { class: 'muted small' }, `Semana ${isoWeek(monday)}`)),
    h('p', { class: 'week-total' }, h('b', {}, formatHours(w.total)), h('span', { class: 'muted' }, ` / ${formatHours(w.soll)}`)),
    h('div', { class: ['progress', over && 'progress-over'], role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(w.soll / 60)), 'aria-valuenow': String(Math.round(w.total / 60)), 'aria-label': 'Horas de esta semana' },
      h('div', { class: 'progress-fill', style: { width: `${pct}%` } })),
    h('p', { class: 'week-msg muted' }, msg),
    h('div', { class: 'week-strip' }, w.days.map((d, i) => {
      const entry = state.days[d.key];
      const first = entry?.codes?.[0];
      return h('div', { class: ['ws-day', d.key === today && 'is-today', d.key < today && 'is-past', d.weekend && 'is-weekend'] },
        h('span', { class: 'ws-dow' }, DOW[i]),
        h('span', { class: 'ws-badge' }, first ? badge(state, first, { size: 'sm', title: false }) : h('span', { class: 'ws-none' }, '·')));
    })));
  }

  function nextDays(state, today) {
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const key = addDays(today, i);
      const s = daySummary(state, key);
      const dow = i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : cap(weekdayShort(key));
      rows.push(h('li', {}, h('button', {
        class: ['mini-row', i === 0 && 'is-today'], type: 'button',
        'aria-label': `${cap(formatLong(key))}: ${s.known ? (s.name || 'sin turnos') : 'sin plan'}${s.time ? `, ${s.time}` : ''}`,
        on: { click: () => ctx.openDay(key) },
      },
      h('span', { class: 'mini-date' }, h('span', { class: 'mini-dow' }, dow), h('span', { class: 'mini-num' }, String(+key.slice(8)))),
      s.known && s.codes.length ? badgeRow(state, s.codes, { size: 'sm' }) : h('span', { class: 'badges' }),
      h('span', { class: 'mini-info' },
        h('span', { class: 'mini-name' }, s.known ? (s.name || '—') : h('span', { class: 'faint' }, 'Sin plan')),
        s.time ? h('span', { class: 'mini-time' }, s.time) : null),
      h('span', { class: 'mini-hours' }, s.hours || ''))));
    }
    return h('section', { class: 'section' },
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title' }, 'Próximos días'),
        h('button', { class: 'link-btn', type: 'button', on: { click: () => ctx.go('calendario', { key: today }) } }, 'Ver mes')),
      h('ul', { class: 'card list-card mini-list' }, rows));
  }

  function emptyState() {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, emptyArt()),
      h('h2', { class: 'empty-title' }, 'Aún no tienes turnos'),
      h('p', { class: 'empty-text' }, 'Haz una foto de tu plan de turnos (en la app Dienstplan o la hoja del PC) y la app los apunta por ti.'),
      h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', on: { click: () => ctx.go('escanear') } }, icon('camera'), 'Escanear mi plan'),
      h('button', { class: 'btn btn-plain btn-block', type: 'button', on: { click: () => ctx.go('calendario') } }, 'o añádelos a mano en el calendario'));
  }

  function render(state) {
    const now = ctx.now();
    const today = ctx.today();
    const name = (state.settings.name || '').trim();
    const hasData = Object.keys(state.days).length > 0;
    const advice = getAdvice(state, now);
    setChildren(el, 
      h('header', { class: 'page-head' },
        h('p', { class: 'eyebrow' }, formatLong(today)),
        h('h1', { class: 'large-title' }, name ? `Hola, ${name} 👋` : 'Hola 👋'),
        hasData ? todayLine(state, today, now) : null),
      ...(hasData ? [
        hero(state, now, today),
        weekCard(state, today),
        nextDays(state, today),
        advice.length ? h('section', { class: 'section' },
          h('div', { class: 'section-head' },
            h('h2', { class: 'section-title' }, 'Consejos'),
            advice.length > 3 ? h('button', { class: 'link-btn', type: 'button', on: { click: () => ctx.go('horas', { advice: true }) } }, `Ver todos (${advice.length})`) : null),
          h('div', { class: 'advice-list' }, advice.slice(0, 3).map((a) => adviceCard(ctx, a)))) : null,
      ] : [emptyState()]),
    );
  }

  return { el, render, tick: () => render(ctx.store.get()) };
}

// Ilustración del estado vacío: teléfono con el plan y una cámara
function emptyArt() {
  const s = document.createElement('span');
  s.innerHTML = `<svg viewBox="0 0 200 150" width="200" height="150" role="presentation">
    <defs><linearGradient id="ea-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFB45C"/><stop offset="1" stop-color="#EF8A17"/></linearGradient></defs>
    <circle cx="100" cy="78" r="64" fill="var(--accent-soft)"/>
    <rect x="62" y="18" width="76" height="124" rx="14" fill="var(--card)" stroke="var(--line-strong)" stroke-width="2"/>
    <rect x="62" y="18" width="76" height="24" rx="14" fill="url(#ea-g)"/><rect x="62" y="30" width="76" height="12" fill="url(#ea-g)"/>
    <g font-family="-apple-system,system-ui,sans-serif" font-size="9" font-weight="700" text-anchor="middle">
      <ellipse cx="88" cy="58" rx="10" ry="8" fill="#F2E500"/><text x="88" y="61" fill="#1F1F1F">F1</text>
      <ellipse cx="112" cy="58" rx="11" ry="8" fill="#E31CE0"/><text x="112" y="61" fill="#fff">F51</text>
      <ellipse cx="88" cy="80" rx="10" ry="8" fill="#8DC47E"/><text x="88" y="83" fill="#1F1F1F">S1</text>
      <rect x="82" y="100" width="12" height="3" rx="1.5" fill="#D21F1F"/>
      <ellipse cx="88" cy="122" rx="10" ry="8" fill="#3D63B8"/><text x="88" y="125" fill="#fff">N1</text>
    </g>
    <g stroke="var(--line)" stroke-width="1.5"><path d="M68 69h64M68 91h64M68 111h64"/></g>
    <g transform="translate(130 92)"><circle r="22" fill="url(#ea-g)"/><path d="M-10 -3a3 3 0 0 1 3-3h2l2-3h6l2 3h2a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-14a3 3 0 0 1-3-3z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><circle cy="2" r="4" fill="none" stroke="#fff" stroke-width="2.2"/></g>
  </svg>`;
  return s.firstElementChild;
}
