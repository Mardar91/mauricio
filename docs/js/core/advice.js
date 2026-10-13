// Consejos para la pantalla "Hoy" y "Horas": descanso, carga de trabajo, datos que faltan…
import { countsAsWork, getCode, isNightCode, shiftInterval } from './codes.js';
import { addDays, diffDays, formatHours, formatLong, formatShort, formatSignedHours, formatTime, monthName, toKey, weekStart } from './dates.js';
import { monthSummary, weekSummary } from './hours.js';

// Orden: nivel y después prio (menor = más importante dentro del nivel)
const LEVEL = { alert: 3, warn: 2, info: 1 };
const MIN_REST_MS = 11 * 3600 * 1000;

// Turnos con horario que cuentan como trabajo, ordenados por inicio
function workIntervals(state, from, to) {
  const out = [];
  for (let key = from; key <= to; key = addDays(key, 1)) {
    const entry = state?.days?.[key];
    if (!entry) continue;
    for (const code of entry.codes) {
      const def = getCode(state, code);
      if (def.kind !== 'shift' || !countsAsWork(def)) continue;
      const iv = shiftInterval(state, key, code);
      if (iv) out.push({ key, code, def, ...iv });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const worksOn = (state, key) => (state?.days?.[key]?.codes || [])
  .some((c) => { const d = getCode(state, c); return d.kind === 'shift' && countsAsWork(d); });

// Día libre: hay plan y no hay turno (incluye '-', 'W-', vacaciones y plan vacío)
const freeOn = (state, key) => Boolean(state?.days?.[key]) && !worksOn(state, key);

const hasKind = (state, key, kinds) => (state?.days?.[key]?.codes || []).some((c) => kinds.includes(getCode(state, c).kind));

function restRules(state, now, today, out) {
  const list = workIntervals(state, addDays(today, -1), addDays(today, 28));
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (b.end <= now) continue;
    const gap = b.start - a.end;
    if (gap <= 0) {
      out.push({
        id: `overlap-${b.key}-${b.code}`, prio: 0, level: 'alert', icon: '⛔', key: b.key,
        title: 'Dos turnos se pisan',
        text: `El ${a.code} del ${formatShort(a.key)} termina a las ${formatTime(a.end)} y el ${b.code} del ${formatShort(b.key)} empieza a las ${formatTime(b.start)}. Revisa el plan: así no puede ser.`,
      });
    } else if (gap < MIN_REST_MS) {
      out.push({
        id: `rest-${b.key}-${b.code}`, prio: 0, level: 'warn', icon: '😴', key: b.key,
        title: 'Poco descanso entre turnos',
        text: `Entre el ${a.code} (${formatShort(a.key)}) y el ${b.code} (${formatShort(b.key)}) solo tienes ${formatHours(Math.round(gap / 60000))} de descanso. Acuéstate pronto y deja todo listo la noche antes.`,
      });
    }
  }
}

function streakRule(state, today, out) {
  const from = addDays(today, -14), to = addDays(today, 28);
  let runStart = null;
  const flush = (endKey) => {
    if (!runStart) return;
    const n = diffDays(runStart, endKey) + 1;
    if (n >= 6 && endKey >= today) {
      const alert = n >= 8;
      out.push({
        id: `streak-${runStart}`, prio: 1, level: alert ? 'alert' : 'warn', icon: alert ? '🚨' : '💪', key: runStart,
        title: `${n} días seguidos trabajando`,
        text: `Del ${formatShort(runStart)} al ${formatShort(endKey)} trabajas ${n} días sin parar. `
          + (alert ? 'Es demasiado: habla con tu coordinación si puedes y cuida mucho tu descanso.'
            : 'Guarda energía, come bien y descansa todo lo que puedas.'),
      });
    }
    runStart = null;
  };
  for (let key = from; key <= to; key = addDays(key, 1)) {
    if (worksOn(state, key)) { if (!runStart) runStart = key; }
    else flush(addDays(key, -1));
  }
  flush(to);
}

function weekRules(state, today, out) {
  const weekly = (Number(state?.settings?.weeklyHours) || 35) * 60;
  [weekStart(today), addDays(weekStart(today), 7)].forEach((monday, i) => {
    const w = weekSummary(state, monday);
    const which = i === 0 ? 'Esta semana' : 'La próxima semana';
    if (w.total > weekly + 4 * 60) {
      out.push({
        id: `week-heavy-${monday}`, prio: 3, level: 'warn', icon: '🏋️', key: monday,
        title: i === 0 ? 'Semana pesada' : 'Se viene una semana pesada',
        text: `${which} tienes ${formatHours(w.total)} planificadas (tu contrato: ${formatHours(weekly)}). Reserva tiempo para descansar.`,
      });
    } else if (w.known === 7 && w.credited === 0 && w.soll > 0 && w.total < w.soll - 8 * 60) {
      out.push({
        id: `week-light-${monday}`, prio: 4, level: 'info', icon: '🍃', key: monday,
        title: 'Semana tranquila',
        text: `${which} tienes ${formatHours(w.total)} planificadas, ${formatHours(w.soll - w.total)} menos que tu objetivo. Si no es lo que esperabas, revisa el plan.`,
      });
    }
  });
}

function monthRule(state, now, out) {
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const s = monthSummary(state, y, m);
  if (!s.daysKnown) return;
  const missing = s.days.length - s.daysKnown;
  out.push({
    id: `month-${y}-${String(m).padStart(2, '0')}`, prio: 5, level: 'info', icon: '📊',
    title: `Balance de ${monthName(m)}`,
    text: missing
      ? `Por ahora tienes ${formatHours(s.total)} planificadas de ${formatHours(s.soll)} (${formatSignedHours(s.diff)}), pero faltan ${missing} días por cargar.`
      : `Tienes ${formatHours(s.total)} planificadas de ${formatHours(s.soll)} (${formatSignedHours(s.diff)}).`,
  });
}

function nightRule(state, now, today, out) {
  for (let key = addDays(today, -1); key <= addDays(today, 3); key = addDays(key, 1)) {
    const night = (state?.days?.[key]?.codes || []).map((c) => getCode(state, c)).find((d) => countsAsWork(d) && isNightCode(d));
    if (!night) continue;
    const iv = shiftInterval(state, key, night.code);
    if (iv.end <= now || iv.start - now > 72 * 3600 * 1000) continue;
    // Si la noche anterior también es noche, el bloque ya empezó
    let first = key;
    while (state.days[addDays(first, -1)]?.codes.some((c) => isNightCode(getCode(state, c)))) first = addDays(first, -1);
    let n = 0;
    for (let k = first; state.days[k]?.codes.some((c) => isNightCode(getCode(state, c))); k = addDays(k, 1)) n++;
    out.push({
      id: `nights-${first}`, prio: 0, level: 'info', icon: '🌙', key: first,
      title: n > 1 ? `${n} noches seguidas` : 'Turno de noche',
      text: `${first <= today ? 'Estás en' : 'Se acerca'} ${n > 1 ? 'un bloque de noches' : 'una noche'} (desde el ${formatLong(first)}). `
        + 'Duerme un rato antes, bebe agua, come ligero y no conduzcas si tienes sueño.',
    });
    return;
  }
}

function unconfirmedRule(state, today, out) {
  const seen = new Map();
  for (let key = today; key <= addDays(today, 30); key = addDays(key, 1)) {
    for (const code of state?.days?.[key]?.codes || []) {
      const def = getCode(state, code);
      if (def.confirmed === false && ['shift', 'event', 'other'].includes(def.kind) && !seen.has(def.code)) seen.set(def.code, { key, def });
    }
  }
  for (const [code, { key, def }] of seen) {
    if (def.kind === 'other') {
      out.push({
        id: `unconfirmed-${code}`, prio: 2, level: 'warn', icon: '❓', key, code,
        title: `Código nuevo: ${code}`,
        text: `El ${formatLong(key)} aparece "${code}" y la app no sabe qué es. Dile su horario o lugar en Ajustes → Códigos.`,
        action: { tab: 'ajustes', label: 'Revisar código' },
      });
      continue;
    }
    const horario = def.start && def.end ? `un horario supuesto (${def.start}–${def.end})` : 'un horario sin definir';
    out.push({
      id: `unconfirmed-${code}`, prio: 2, level: 'warn', icon: '❓', key, code,
      title: `Confirma el horario de ${code}`,
      text: `El ${code} del ${formatLong(key)} tiene ${horario}. Revísalo en Ajustes → Códigos.`,
      action: { tab: 'ajustes', label: 'Revisar horario' },
    });
  }
}

function missingDataRule(state, today, out) {
  const future = Object.keys(state?.days || {}).filter((k) => k >= today).sort();
  if (!future.length) {
    out.push({
      id: 'missing-data', prio: 1, level: 'info', icon: '📷',
      title: 'Sube tu plan',
      text: 'No tienes turnos cargados para los próximos días. Haz una foto del plan y súbela.',
      action: { tab: 'escanear', label: 'Escanear mi plan' },
    });
    return;
  }
  const last = future[future.length - 1];
  if (diffDays(today, last) + 1 <= 7) {
    out.push({
      id: 'missing-data', prio: 1, level: 'info', icon: '📷', key: last,
      title: 'Sube el plan del próximo mes',
      text: `Tu plan llega solo hasta el ${formatLong(last)}. En cuanto lo tengas, haz una foto del plan siguiente.`,
      action: { tab: 'escanear', label: 'Escanear' },
    });
  }
}

function freeDaysRule(state, today, out) {
  const end = addDays(today, 7);
  for (let key = today; key <= end; key = addDays(key, 1)) {
    if (!freeOn(state, key)) continue;
    let last = key;
    while (freeOn(state, addDays(last, 1))) last = addDays(last, 1);
    const n = diffDays(key, last) + 1;
    if (n >= 2) {
      let vacation = false;
      for (let k = key; k <= last; k = addDays(k, 1)) if (hasKind(state, k, ['vacation'])) vacation = true;
      out.push({
        id: `free-${key}`, prio: 3, level: 'info', icon: vacation ? '🏖️' : '🌿', key,
        title: vacation ? '¡Vacaciones a la vista!' : 'Días libres a la vista',
        text: `Del ${formatShort(key)} al ${formatShort(last)} tienes ${n} días libres. ¡Disfrútalos y descansa!`,
      });
      return;
    }
    key = last;
  }
}

function remindersRule(state, out) {
  const s = state?.settings || {};
  if (s.sync?.enabled || s.ntfy?.enabled) return;
  out.push({
    id: 'reminders-off', prio: 2, level: 'info', icon: '🔔',
    title: 'Activa los recordatorios',
    text: 'Así tu iPhone te avisa la víspera y antes de cada turno. Se activa en Ajustes en un par de minutos.',
    action: { tab: 'ajustes', label: 'Ir a Ajustes' },
  });
}

export function getAdvice(state, now = new Date()) {
  const today = toKey(now);
  const out = [];
  restRules(state, now, today, out);
  streakRule(state, today, out);
  weekRules(state, today, out);
  monthRule(state, now, out);
  nightRule(state, now, today, out);
  unconfirmedRule(state, today, out);
  missingDataRule(state, today, out);
  freeDaysRule(state, today, out);
  remindersRule(state, out);
  return out
    .sort((a, b) => LEVEL[b.level] - LEVEL[a.level] || a.prio - b.prio || String(a.key ?? '').localeCompare(String(b.key ?? '')))
    .map(({ prio, ...rest }) => rest);
}
