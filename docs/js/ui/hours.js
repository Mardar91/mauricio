// Pestaña "Horas": resumen del mes frente al objetivo (Soll), semanas, estadísticas y consejos.
import {
  formatHours, formatMonth, formatSignedHours, getAdvice, getCode, isoWeek, monthShort, monthSummary, addDays,
} from '../core/index.js';
import { badge } from './badge.js';
import { cap, fmtNum, h, setChildren } from './dom.js';
import { icon } from './icons.js';
import { adviceCard } from './today.js';

export function createHours(ctx) {
  const el = h('section', { 'aria-label': 'Horas' });
  const t = ctx.today();
  let year = +t.slice(0, 4), month = +t.slice(5, 7);
  let scrollToAdvice = false;

  function shift(n) {
    const d = new Date(year, month - 1 + n, 1);
    year = d.getFullYear(); month = d.getMonth() + 1;
    render(ctx.store.get());
  }

  function stat(emoji, value, label) {
    return h('div', { class: 'stat' },
      h('span', { class: 'stat-emoji', 'aria-hidden': 'true' }, emoji),
      h('span', { class: 'stat-value' }, value),
      h('span', { class: 'stat-label' }, label));
  }

  function render(state) {
    const s = monthSummary(state, year, month);
    const weekly = (Number(state.settings.weeklyHours) || 35) * 60;
    const missing = s.days.length - s.daysKnown;
    const pct = s.soll ? Math.min(100, (s.total / s.soll) * 100) : 0;
    const diffCls = s.diff >= 0 ? 'pos' : s.diff > -8 * 60 ? 'neg-soft' : 'neg';
    const diffText = Math.abs(s.diff) < 15 ? 'Justo tu objetivo 👌'
      : s.diff > 0 ? 'por encima del objetivo' : 'por debajo del objetivo';
    const workdays = Math.round(s.soll / ((weekly / (Number(state.settings.workDaysPerWeek) || 5)) || 1));

    const summary = h('article', { class: 'card hours-summary' },
      h('div', { class: 'hs-cols' },
        h('div', { class: 'hs-col' }, h('span', { class: 'hs-label' }, 'Planificado'), h('span', { class: 'hs-value' }, formatHours(s.total))),
        h('div', { class: 'hs-col' }, h('span', { class: 'hs-label' }, 'Objetivo'), h('span', { class: 'hs-value muted-strong' }, formatHours(s.soll)))),
      h('div', { class: ['progress', 'progress-lg', s.total > s.soll && 'progress-over'], role: 'progressbar', 'aria-label': 'Horas del mes frente al objetivo', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(s.soll / 60)), 'aria-valuenow': String(Math.round(s.total / 60)) },
        h('div', { class: 'progress-fill', style: { width: `${pct}%` } })),
      h('p', { class: 'hs-diff' }, h('b', { class: ['diff', diffCls] }, formatSignedHours(s.diff)), ' ', h('span', { class: 'muted' }, diffText)),
      h('p', { class: 'hs-foot muted small' },
        `Objetivo: ${workdays} días laborables × ${formatHours(weekly / (Number(state.settings.workDaysPerWeek) || 5))} (festivos descontados).`,
        s.credited ? ` Incluye ${formatHours(s.credited)} de vacaciones.` : ''),
      missing > 0 ? h('p', { class: 'notice notice-info small' }, icon('info'), h('span', {},
        s.daysKnown ? `Faltan ${missing} ${missing === 1 ? 'día' : 'días'} por cargar: el total puede cambiar.` : 'Este mes todavía no tiene turnos cargados.')) : null);

    const stats = h('div', { class: 'stats' },
      stat('🌙', String(s.nights), s.nights === 1 ? 'noche' : 'noches'),
      stat('📅', String(s.weekendsWorked), s.weekendsWorked === 1 ? 'fin de semana trabajado' : 'fines de semana trabajados'),
      stat('🏖️', String(s.vacationDays), s.vacationDays === 1 ? 'día de vacaciones' : 'días de vacaciones'),
      stat('🌿', String(s.freeDays), s.freeDays === 1 ? 'día libre' : 'días libres'));

    const maxWeek = Math.max(weekly + 8 * 60, ...s.weeks.map((w) => w.total));
    const weeks = h('section', { class: 'section' },
      h('h2', { class: 'section-title' }, 'Semanas'),
      h('ul', { class: 'card list-card week-bars' }, s.weeks.map((w) => {
        const sun = addDays(w.from, 6);
        const fill = (w.total / maxWeek) * 100;
        const mark = (w.soll / maxWeek) * 100;
        const cls = w.total > w.soll + 4 * 60 ? 'heavy' : w.total > w.soll ? 'over' : '';
        return h('li', { class: 'wb-row' },
          h('div', { class: 'wb-head' },
            h('span', { class: 'wb-title' }, `Semana ${isoWeek(w.from)}`),
            h('span', { class: 'wb-range muted small' }, `${+w.from.slice(8)} ${monthShort(+w.from.slice(5, 7))} – ${+sun.slice(8)} ${monthShort(+sun.slice(5, 7))}`),
            h('span', { class: 'wb-value' }, h('b', {}, formatHours(w.total)), h('span', { class: 'muted' }, ` / ${formatHours(w.soll)}`))),
          h('div', { class: ['wb-bar', cls], 'aria-hidden': 'true' },
            h('span', { class: 'wb-fill', style: { width: `${fill}%` } }),
            h('span', { class: 'wb-mark', style: { left: `${mark}%` } })),
          w.known < 7 ? h('span', { class: 'wb-note faint small' }, `${7 - w.known} ${7 - w.known === 1 ? 'día' : 'días'} sin plan`) : null);
      })));

    const counts = Object.entries(s.shiftCounts).sort((a, b) => b[1] - a[1]);
    const shifts = counts.length ? h('section', { class: 'section' },
      h('h2', { class: 'section-title' }, 'Turnos del mes'),
      h('div', { class: 'card shift-counts' }, counts.map(([code, n]) => h('span', { class: 'sc-item' },
        badge(state, code), h('span', { class: 'sc-n' }, `× ${n}`), h('span', { class: 'sc-name muted small' }, getCode(state, code).name))))) : null;

    const advice = getAdvice(state, ctx.now());
    const adviceSec = h('section', { class: 'section', id: 'hours-advice' },
      h('h2', { class: 'section-title' }, 'Consejos'),
      advice.length ? h('div', { class: 'advice-list' }, advice.map((a) => adviceCard(ctx, a)))
        : h('p', { class: 'muted' }, 'Todo en orden. ¡Buen trabajo! 💪'));

    setChildren(el, 
      h('header', { class: 'page-head' },
        h('h1', { class: 'large-title' }, 'Horas'),
        h('div', { class: 'pill-switch' },
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Mes anterior', on: { click: () => shift(-1) } }, icon('chevronLeft')),
          h('span', { class: 'pill-switch-label', 'aria-live': 'polite' }, cap(formatMonth(year, month))),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Mes siguiente', on: { click: () => shift(1) } }, icon('chevronRight')))),
      summary,
      stats,
      weeks,
      shifts,
      adviceSec,
      h('p', { class: 'muted small center foot-note' }, `Contrato: ${fmtNum(Number(state.settings.weeklyHours) || 35)} h por semana · se cambia en Ajustes.`),
    );
    if (scrollToAdvice) {
      scrollToAdvice = false;
      requestAnimationFrame(() => document.getElementById('hours-advice')?.scrollIntoView({ block: 'start' }));
    }
  }

  return {
    el,
    render,
    onShow(opts) {
      if (opts?.advice) {
        const k = ctx.today();
        year = +k.slice(0, 4); month = +k.slice(5, 7);
        scrollToAdvice = true;
        render(ctx.store.get());
        return true;
      }
      return false;
    },
  };
}
