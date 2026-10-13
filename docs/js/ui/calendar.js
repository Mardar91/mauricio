// Pestaña "Calendario": lista del mes como la app Dienstplan, con totales por semana.
import {
  addDays, formatHours, formatMonth, isWeekend, isoWeek, monthKeys, monthSummary,
  monthShort, weekStart, weekSummary, weekdayShort, formatSignedHours,
} from '../core/index.js';
import { badgeRow } from './badge.js';
import { cap, h, setChildren } from './dom.js';
import { icon } from './icons.js';
import { banners } from './banners.js';
import { daySummary } from './shifts.js';

export function createCalendar(ctx) {
  const el = h('section', { 'aria-label': 'Calendario' });
  const t = ctx.today();
  let year = +t.slice(0, 4), month = +t.slice(5, 7);
  let shown = false;

  const prevBtn = h('button', { class: 'icon-btn nav-arrow', type: 'button', 'aria-label': 'Mes anterior', on: { click: () => shift(-1) } }, icon('chevronLeft'));
  const nextBtn = h('button', { class: 'icon-btn nav-arrow', type: 'button', 'aria-label': 'Mes siguiente', on: { click: () => shift(1) } }, icon('chevronRight'));
  const title = h('h1', { class: 'nav-title', 'aria-live': 'polite' });
  const todayBtn = h('button', { class: 'btn btn-tinted btn-sm today-btn', type: 'button', 'aria-label': 'Ir a hoy', on: { click: () => goToday() } }, 'Hoy');
  const header = h('header', { class: 'navbar' },
    h('div', { class: 'navbar-inner' }, todayBtn, h('div', { class: 'month-switch' }, prevBtn, title, nextBtn), h('span', { class: 'navbar-spacer' })));
  const bannerHost = h('div', { class: 'banner-host' });
  const summary = h('div', { class: 'month-summary' });
  const partial = h('p', { class: 'month-partial', hidden: true });
  const list = h('ol', { class: 'month-list', 'aria-label': 'Días del mes' });
  el.append(header, bannerHost, summary, partial, list);

  function shift(n) {
    const d = new Date(year, month - 1 + n, 1);
    year = d.getFullYear(); month = d.getMonth() + 1;
    render(ctx.store.get());
    window.scrollTo({ top: 0 });
  }

  function goToday() {
    const k = ctx.today();
    year = +k.slice(0, 4); month = +k.slice(5, 7);
    render(ctx.store.get());
    scrollToKey(k, true);
  }

  function scrollToKey(key, smooth = false) {
    const row = list.querySelector(`[data-key="${key}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const target = window.scrollY + r.top - window.innerHeight * 0.35;
    window.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
  }

  // Cambiar de mes deslizando a los lados
  let sx = null, sy = null;
  list.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  list.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) shift(dx < 0 ? 1 : -1);
  });

  // Ordenador: flechas ← → del teclado para cambiar de mes (sin hojas abiertas ni un campo con el foco)
  document.addEventListener('keydown', (e) => {
    if (el.hidden || !el.isConnected || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (document.querySelector('.sheet-wrap, .dialog-wrap, .onboarding')) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
    e.preventDefault();
    shift(e.key === 'ArrowRight' ? 1 : -1);
  });

  function weekHeader(state, monday) {
    const w = weekSummary(state, monday);
    const pct = w.soll ? Math.min(100, (w.total / w.soll) * 100) : 0;
    const sunday = addDays(monday, 6);
    // «12–18 oct» en el mismo mes; «31 ago – 6 sept» entre dos meses
    const m1 = +monday.slice(5, 7), m2 = +sunday.slice(5, 7);
    const range = m1 === m2 ? `${+monday.slice(8)}–${+sunday.slice(8)} ${monthShort(m1)}`
      : `${+monday.slice(8)} ${monthShort(m1)} – ${+sunday.slice(8)} ${monthShort(m2)}`;
    const cls = w.total > w.soll + 4 * 60 ? 'heavy' : w.total > w.soll ? 'over' : '';
    return h('header', { class: 'week-sep' },
      h('span', { class: 'week-sep-text' },
        h('span', { class: 'week-sep-title' }, `Semana ${isoWeek(monday)}`),
        h('span', { class: 'week-sep-range' }, range)),
      h('span', { class: 'week-sep-total', 'aria-label': `Total semana: ${formatHours(w.total)} de ${formatHours(w.soll)}` },
        h('span', { class: 'week-sep-hours' }, h('b', {}, formatHours(w.total)), ` / ${formatHours(w.soll)}`),
        h('span', { class: ['mini-bar', cls], 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } }))));
  }

  function dayRow(state, key, today) {
    const s = daySummary(state, key);
    const weekend = isWeekend(key);
    const isToday = key === today;
    const label = `${cap(weekdayShort(key))} ${+key.slice(8)}: ${s.known ? (s.name || 'nada planificado') : 'sin plan'}${s.time ? `, ${s.time}` : ''}${s.special ? ', horario especial' : ''}${s.hours ? `, ${s.hours}` : ''}${s.holiday ? `, festivo: ${s.holiday}` : ''}${s.note ? ', con nota' : ''}`;
    let line1 = '', line2 = '';
    if (s.known && s.codes.length) {
      if (s.time) { line1 = s.time; line2 = [s.name, s.hours].filter(Boolean).join(' · '); }
      else { line1 = s.name; line2 = s.hours; }
    } else if (s.known) {
      line1 = 'Nada planificado';
    }
    if (s.holiday) {
      if (!line1) { line1 = 'Festivo'; line2 = s.holiday; }
      else line2 = `🎉 ${line2 || 'Festivo'}`;
    }
    return h('li', { class: 'day-li' }, h('button', {
      class: ['day-row', weekend && 'weekend', isToday && 'today', s.holiday && 'holiday', key < today && 'past'],
      type: 'button', dataset: { key }, 'aria-label': label, 'aria-current': isToday ? 'date' : null,
      on: { click: () => ctx.openDay(key) },
    },
    h('span', { class: 'd-num', 'aria-hidden': 'true' }, h('span', { class: 'd-day' }, key.slice(8)), h('span', { class: 'd-dow' }, weekdayShort(key))),
    h('span', { class: 'd-codes', 'aria-hidden': 'true' },
      s.known && s.codes.length ? badgeRow(state, s.codes, { title: false }) : null,
      s.note ? h('span', { class: 'd-note' }, icon('note')) : null,
      s.special ? h('span', { class: 'd-special', 'data-testid': 'special-mark' }, 'horario especial') : null),
    h('span', { class: 'd-right', 'aria-hidden': 'true' },
      line1 ? h('span', { class: ['d-l1', !s.codes?.length && 'faint', s.special && s.time && 'is-special'] }, line1) : null,
      line2 ? h('span', { class: 'd-l2' }, line2) : null)));
  }

  function render(state) {
    const today = ctx.today();
    title.textContent = cap(formatMonth(year, month));

    const ms = monthSummary(state, year, month);
    // Mes vacío o a medias: la diferencia todavía no dice nada (como en Horas): «—» y sin colores
    const complete = ms.daysKnown === ms.days.length;
    const diffCls = !complete ? 'muted-strong' : ms.diff >= 0 ? 'pos' : ms.diff > -8 * 60 ? 'neg-soft' : 'neg';
    setChildren(summary,
      h('div', { class: 'ms-item' }, h('span', { class: 'ms-label' }, 'Planificado'), h('b', { class: 'ms-value' }, formatHours(ms.total))),
      h('div', { class: 'ms-item' }, h('span', { class: 'ms-label' }, 'Objetivo'), h('b', { class: 'ms-value' }, formatHours(ms.soll))),
      h('div', { class: 'ms-item', 'data-testid': 'month-diff' }, h('span', { class: 'ms-label' }, 'Diferencia'),
        h('b', { class: ['ms-value', diffCls] }, complete ? formatSignedHours(ms.diff) : '—')),
    );
    setChildren(bannerHost, banners(ctx, state, 'calendario'));
    const missing = ms.days.length - ms.daysKnown;
    summary.classList.toggle('incomplete', missing > 0 && ms.daysKnown > 0);
    // Mes a medias: el planificado todavía no se puede comparar con el objetivo
    partial.hidden = !(missing > 0 && ms.daysKnown > 0);
    partial.textContent = missing === 1 ? 'Falta 1 día del plan de este mes: el total todavía puede cambiar.'
      : `Faltan ${missing} días del plan de este mes: el total todavía puede cambiar.`;

    // Una tarjeta por semana (lunes a domingo) con su total
    const weeks = new Map();
    for (const key of monthKeys(year, month)) {
      const monday = weekStart(key);
      if (!weeks.has(monday)) weeks.set(monday, []);
      weeks.get(monday).push(key);
    }
    const items = [...weeks.entries()].map(([monday, keys]) => h('li', { class: 'week', dataset: { week: monday } },
      weekHeader(state, monday),
      h('ol', { class: 'card week-days' }, keys.map((k) => dayRow(state, k, today)))));
    setChildren(list, ...items);
    if (!ms.daysKnown) {
      list.prepend(h('li', { class: 'card month-empty' },
        h('p', { class: 'month-empty-title' }, `Sin turnos en ${formatMonth(year, month)}`),
        h('p', { class: 'muted small' }, 'Escanea el plan, o toca cualquier día de abajo para elegir su turno a mano.'),
        h('div', { class: 'btn-row btn-row-center' },
          h('button', { class: 'btn btn-tinted btn-sm', type: 'button', on: { click: () => ctx.go('escanear') } }, icon('camera'), 'Escanear el plan'),
          h('button', { class: 'btn btn-secondary btn-sm', type: 'button', on: { click: () => ctx.go('escanear', { manual: true }) } }, icon('pencil'), 'Escribir a mano'))));
    }
  }

  return {
    el,
    render,
    // opts: { key } para ir a un día, { year, month } para ir a un mes
    onShow(opts, again) {
      const k = opts?.key || (again ? ctx.today() : null);
      if (opts?.year && opts?.month) {
        year = opts.year; month = opts.month;
        render(ctx.store.get());
        window.scrollTo(0, 0);
        return true;
      }
      if (k) {
        year = +k.slice(0, 4); month = +k.slice(5, 7);
        render(ctx.store.get());
        scrollToKey(k);
        return true;
      }
      if (!shown) {
        shown = true;
        // Mes sin turnos: se queda arriba para que se vea la explicación
        const t0 = ctx.today();
        if (monthSummary(ctx.store.get(), +t0.slice(0, 4), +t0.slice(5, 7)).daysKnown === 0) { window.scrollTo(0, 0); return true; }
        requestAnimationFrame(() => scrollToKey(t0));
        return true;
      }
      return false;
    },
    get month() { return { year, month }; },
  };
}
