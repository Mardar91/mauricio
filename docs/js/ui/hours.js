// Pestaña "Horas": resumen del mes frente al objetivo (Soll), semanas, estadísticas, suplementos del mes,
// saldos (horas acumuladas y vacaciones del año) y consejos.
import {
  SUPPLEMENT_NOTE, formatHours, formatMonth, formatSignedHours, getAdvice, getCode, isoWeek, monthShort, monthSummary,
  addDays, overtimeBalance, vacationSummary,
} from '../core/index.js';
import { badge } from './badge.js';
import { cap, fmtNum, h, plural, setChildren } from './dom.js';

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const euro = (n) => EUR.format(Number(n) || 0);
import { icon } from './icons.js';
import { banners } from './banners.js';
import { adviceCard } from './today.js';
import { forDevice } from './platform.js';

// «Incluye 7 h de vacaciones» / «… de enfermedad» / «… de vacaciones y 7 h de enfermedad» (ambas se
// acreditan como jornada)
function creditedText(state, s) {
  if (!s.credited) return '';
  let vac = 0, sick = 0;
  for (const d of s.days) {
    for (const it of d.items || []) {
      if (it.type !== 'credited' || !it.minutes) continue;
      if (getCode(state, it.code)?.kind === 'sick') sick += it.minutes; else vac += it.minutes;
    }
  }
  if (!vac && !sick) return ` Incluye ${formatHours(s.credited)} de vacaciones o enfermedad.`;
  const parts = [vac ? `${formatHours(vac)} de vacaciones` : '', sick ? `${formatHours(sick)} de enfermedad` : ''].filter(Boolean);
  return ` Incluye ${parts.join(' y ')}.`;
}

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
    const partial = missing > 0 && s.daysKnown > 0;
    const pct = s.soll ? Math.min(100, (s.total / s.soll) * 100) : 0;
    const diffCls = partial || !s.daysKnown ? 'muted-strong' : s.diff >= 0 ? 'pos' : s.diff > -8 * 60 ? 'neg-soft' : 'neg';
    const diffText = !s.daysKnown ? 'todavía sin turnos este mes'
      : partial ? 'por ahora (faltan días del plan)'
        : Math.abs(s.diff) < 15 ? 'Justo tu objetivo 👌'
          : s.diff > 0 ? 'por encima del objetivo' : 'por debajo del objetivo';
    const workdays = Math.round(s.soll / ((weekly / (Number(state.settings.workDaysPerWeek) || 5)) || 1));

    const summary = h('article', { class: ['card', 'hours-summary', partial && 'is-partial'] },
      partial ? h('div', { class: 'notice notice-warn hs-partial', 'data-testid': 'hours-partial' }, icon('info'), h('p', {},
        h('b', {}, missing === 1 ? 'Falta 1 día del plan de este mes. ' : `Faltan ${missing} días del plan de este mes. `),
        'El planificado todavía no está completo: compáralo con el objetivo cuando tengas todo el mes.')) : null,
      h('div', { class: 'hs-cols' },
        h('div', { class: 'hs-col' }, h('span', { class: 'hs-label' }, 'Planificado'), h('span', { class: 'hs-value' }, formatHours(s.total)),
          partial ? h('span', { class: 'hs-note' }, 'hasta ahora') : null),
        h('div', { class: 'hs-col' }, h('span', { class: 'hs-label' }, 'Objetivo'), h('span', { class: 'hs-value muted-strong' }, formatHours(s.soll)))),
      h('div', { class: ['progress', 'progress-lg', s.total > s.soll && 'progress-over'], role: 'progressbar', 'aria-label': 'Horas del mes frente al objetivo', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(s.soll / 60)), 'aria-valuenow': String(Math.round(s.total / 60)) },
        h('div', { class: 'progress-fill', style: { width: `${pct}%` } })),
      // Con el mes a medias la diferencia confunde: no se muestra
      partial || !s.daysKnown ? null : h('p', { class: 'hs-diff' }, h('b', { class: ['diff', diffCls] }, formatSignedHours(s.diff)), ' ', h('span', { class: 'muted' }, diffText)),
      h('p', { class: 'hs-foot muted small' },
        `Objetivo: ${workdays} días laborables × ${formatHours(weekly / (Number(state.settings.workDaysPerWeek) || 5))} (festivos descontados).`,
        creditedText(state, s)),
      !s.daysKnown ? h('p', { class: 'notice notice-info small' }, icon('info'), h('span', {}, 'Este mes todavía no tiene turnos cargados.')) : null);

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
          w.known < 7 ? h('span', { class: 'wb-note faint small' }, `${plural(7 - w.known, 'día', 'días')} sin plan`) : null);
      })));

    const counts = Object.entries(s.shiftCounts).sort((a, b) => b[1] - a[1]);
    const shifts = counts.length ? h('section', { class: 'section' },
      h('h2', { class: 'section-title' }, 'Turnos del mes'),
      h('div', { class: 'card shift-counts' }, counts.map(([code, n]) => h('span', { class: 'sc-item' },
        badge(state, code), h('span', { class: 'sc-n' }, `× ${n}`), h('span', { class: 'sc-name muted small' }, getCode(state, code).name))))) : null;

    const advice = forDevice(getAdvice(state, ctx.now(), { platform: ctx.platform }));
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
      banners(ctx, state, 'horas'),
      summary,
      stats,
      weeks,
      supplementsSection(state, s),
      balancesSection(state),
      shifts,
      adviceSec,
      h('p', { class: 'muted small center foot-note' }, `Contrato: ${fmtNum(Number(state.settings.weeklyHours) || 35)} h por semana · se cambia en Ajustes.`),
    );
    if (scrollToAdvice) {
      scrollToAdvice = false;
      requestAnimationFrame(() => document.getElementById('hours-advice')?.scrollIntoView({ block: 'start' }));
    }
  }

  // Suplementos del mes (SPEC §13.3): horas de noche, sábado, domingo y festivo, y € si hay salario
  function supplementsSection(state, s) {
    const sp = s.supplements;
    if (!sp || !s.worked) return null;
    const wage = sp.hourlyWage;
    const kinds = [['night', '🌙', 'Noche'], ['saturday', '🗓️', 'Sábado'], ['sunday', '☀️', 'Domingo'], ['holiday', '🎉', 'Festivo']];
    const rows = kinds.map(([k, emoji, label]) => {
      const x = sp[k];
      const sub = [x.from && x.to ? `${x.from}–${x.to}` : '', x.pct ? `${fmtNum(x.pct, 1)} %` : 'sin suplemento'].filter(Boolean).join(' · ');
      return h('li', { class: ['sup-row', !x.minutes && 'is-zero'], dataset: { kind: k } },
        h('span', { class: 'sup-emoji', 'aria-hidden': 'true' }, emoji),
        h('span', { class: 'sup-main' }, h('span', { class: 'sup-label' }, label), h('span', { class: 'sup-sub' }, sub)),
        h('span', { class: 'sup-values' },
          h('b', { class: 'sup-hours' }, formatHours(x.minutes)),
          wage !== null && x.pct && x.minutes ? h('span', { class: 'sup-eur' }, euro(x.euros)) : null));
    });
    return h('section', { class: 'section', id: 'hours-supplements', 'data-testid': 'supplements' },
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title' }, 'Suplementos'),
        h('button', { class: 'link-btn', type: 'button', on: { click: () => ctx.go('ajustes', { section: 'payroll' }) } }, 'Cambiar valores')),
      h('div', { class: 'card sup-card' },
        h('ul', { class: 'sup-list' }, rows),
        wage !== null
          ? h('p', { class: 'sup-total', 'data-testid': 'supplements-total' }, h('span', {}, `Estimación con ${euro(wage)}/h`), h('b', {}, `≈ ${euro(sp.euros)}`))
          : h('button', { class: 'link-btn sup-wage', type: 'button', on: { click: () => ctx.go('ajustes', { section: 'payroll' }) } }, icon('wallet'), 'Pon tu salario por hora para ver los €'),
        h('p', { class: 'sup-note' }, SUPPLEMENT_NOTE)));
  }

  // Saldos (SPEC §13.4): horas de más o de menos hasta hoy y vacaciones del año en curso
  function balancesSection(state) {
    const now = ctx.now();
    const ob = overtimeBalance(state, { now });
    const vac = vacationSummary(state, now.getFullYear(), { now });
    const hasPlan = ob.months.length > 0;
    const cls = !hasPlan ? 'muted-strong' : Math.abs(ob.balance) < 15 ? '' : ob.balance > 0 ? 'pos' : 'neg-soft';
    const partial = ob.months.some((m) => !m.complete);
    // Los 3 últimos meses, y debajo lo anterior y el saldo inicial: las líneas suman el total
    const recent = ob.months.slice(-3).reverse();
    const earlier = ob.months.slice(0, -3);
    const tone = (min) => (Math.abs(min) < 15 ? '' : min > 0 ? 'pos' : 'neg-soft');
    const balRow = (label, min, extra = null, testid = null) => h('li', { 'data-testid': testid },
      h('span', {}, label, extra), h('b', { class: tone(min) }, formatSignedHours(min)));
    const rows = recent.map((m) => balRow(cap(formatMonth(m.year, m.month1)), m.diff, m.current ? h('span', { class: 'faint' }, ' (hasta hoy)') : null));
    if (earlier.length) {
      const sum = earlier.reduce((a, m) => a + m.diff, 0);
      rows.push(earlier.length === 1
        ? balRow(cap(formatMonth(earlier[0].year, earlier[0].month1)), sum, null, 'bal-earlier')
        : balRow('Meses anteriores', sum, h('span', { class: 'faint' }, ` (${earlier.length})`), 'bal-earlier'));
    }
    if (ob.startMin && hasPlan) rows.push(balRow('Saldo al empezar', ob.startMin, null, 'bal-start'));
    const hoursCard = h('article', { class: 'card bal-card', 'data-testid': 'overtime' },
      h('div', { class: 'bal-head' }, h('span', { class: 'bal-label' }, 'Saldo de horas'), h('span', { class: 'bal-when muted small' }, 'hasta hoy')),
      h('p', { class: ['bal-value', cls] }, hasPlan || ob.startMin ? formatSignedHours(ob.balance) : '—'),
      h('p', { class: 'bal-sub muted small' }, hasPlan
        ? `Desde ${formatMonth(+ob.startMonth.slice(0, 4), +ob.startMonth.slice(5, 7))}.`
        : ob.startMin ? `Tu saldo al empezar. Todavía no hay turnos hasta hoy.` : 'Todavía no hay turnos hasta hoy.'),
      rows.length ? h('ul', { class: 'bal-months' }, rows) : null,
      partial ? h('p', { class: 'bal-hint faint small' }, 'Solo cuentan los días con plan: los que faltan no suman ni restan.') : null);
    const used = Math.min(vac.used, vac.total), planned = Math.min(vac.planned, Math.max(0, vac.total - used));
    const pctOf = (n) => (vac.total > 0 ? (n / vac.total) * 100 : 0);
    const vacCard = h('article', { class: 'card bal-card', 'data-testid': 'vacation' },
      h('div', { class: 'bal-head' }, h('span', { class: 'bal-label' }, `Vacaciones ${vac.year}`), h('span', { class: 'bal-when muted small' }, 'te quedan')),
      h('p', { class: ['bal-value', vac.remaining < 0 && 'neg'] }, fmtNum(vac.remaining, 1), h('span', { class: 'bal-unit' }, vac.remaining === 1 ? ' día' : ' días')),
      h('p', { class: 'bal-sub muted small' }, `De ${fmtNum(vac.total, 1)} días${vac.carryOver ? ` (${fmtNum(vac.carryOver, 1)} del año pasado)` : ''}.`),
      h('div', { class: 'vac-bar', role: 'img', 'aria-label': `${vac.used} usados, ${vac.planned} planificados, ${fmtNum(vac.remaining, 1)} quedan` },
        h('span', { class: 'vac-used', style: { width: `${pctOf(used)}%` } }),
        h('span', { class: 'vac-planned', style: { width: `${pctOf(planned)}%` } })),
      h('ul', { class: 'vac-legend' },
        h('li', {}, h('span', { class: 'dot dot-used', 'aria-hidden': 'true' }), `Usadas: ${plural(vac.used, 'día', 'días')}`),
        h('li', {}, h('span', { class: 'dot dot-planned', 'aria-hidden': 'true' }), `Planificadas: ${plural(vac.planned, 'día', 'días')}`)));
    return h('section', { class: 'section', id: 'hours-balances', 'data-testid': 'balances' },
      h('div', { class: 'section-head' },
        h('h2', { class: 'section-title' }, 'Saldos'),
        h('button', { class: 'link-btn', type: 'button', on: { click: () => ctx.go('ajustes', { section: 'payroll' }) } }, 'Ajustar')),
      h('div', { class: 'bal-grid' }, hoursCard, vacCard));
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
