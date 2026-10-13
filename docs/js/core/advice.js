// Consejos para la pantalla "Hoy" y "Horas": descanso, carga de trabajo, datos que faltan…
import { countsAsWork, getCode, isNightCode, isTimedCode, shiftInterval } from './codes.js';
import { addDays, diffDays, formatHours, formatLong, formatShort, formatSignedHours, formatTime, monthName, toKey, weekStart } from './dates.js';
import { monthSummary, weekSummary } from './hours.js';

// Orden: nivel y después prio (menor = más importante dentro del nivel)
const LEVEL = { alert: 3, warn: 2, info: 1 };
const MIN_REST_MS = 11 * 3600 * 1000;

// Trabajo con horario (turnos y otros códigos que cuentan horas; no reuniones), ordenado por inicio
function workIntervals(state, from, to) {
  const out = [];
  for (let key = from; key <= to; key = addDays(key, 1)) {
    const entry = state?.days?.[key];
    if (!entry) continue;
    for (const code of entry.codes) {
      const def = getCode(state, code);
      if (def.kind === 'event' || !countsAsWork(def)) continue;
      const iv = shiftInterval(state, key, code);
      if (iv) out.push({ key, code, def, ...iv });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Día de trabajo (para las rachas): algún turno o algo con hora (reunión, código con horario…)
const worksOn = (state, key) => (state?.days?.[key]?.codes || [])
  .some((c) => { const d = getCode(state, c); return d.kind === 'shift' || isTimedCode(d) || countsAsWork(d); });

// Día libre: hay plan y solo tiene '-', 'W-', vacaciones/baja (o está vacío). Un evento o un código
// desconocido NO es un día libre.
const FREE_KINDS = ['off', 'wish', 'vacation', 'sick'];
const freeOn = (state, key) => {
  const entry = state?.days?.[key];
  return Boolean(entry) && (entry.codes || []).every((c) => FREE_KINDS.includes(getCode(state, c).kind));
};

const tsOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };

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
    // ¿Ya empezó la primera noche? (antes de las 22:00 del primer día todavía "se acerca")
    const firstNight = state.days[first].codes.map((c) => getCode(state, c)).find((d) => isNightCode(d));
    const started = shiftInterval(state, first, firstNight.code).start <= now;
    let intro;
    if (n > 1) intro = `${started ? 'Estás en' : 'Se acerca'} un bloque de noches (desde el ${formatLong(first)}).`;
    else if (started) intro = 'Estás en un turno de noche.';
    else intro = first === today ? 'Esta noche trabajas.' : `Se acerca un turno de noche (el ${formatLong(first)}).`;
    out.push({
      id: `nights-${first}`, prio: 0, level: 'info', icon: '🌙', key: first,
      title: n > 1 ? `${n} noches seguidas` : 'Turno de noche',
      text: `${intro} Duerme un rato antes, bebe agua, come ligero y no conduzcas si tienes sueño.`,
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

// Huecos sin plan en los próximos 7 días (antes del último día cargado): sin plan no hay avisos
function gapsRule(state, today, out) {
  const future = Object.keys(state?.days || {}).filter((k) => k >= today).sort();
  if (!future.length) return; // ya lo cubre 'missing-data'
  const last = future[future.length - 1];
  const end = [addDays(today, 6), addDays(last, -1)].sort()[0];
  const missing = [];
  for (let k = today; k <= end; k = addDays(k, 1)) if (!state.days[k]) missing.push(k);
  if (!missing.length) return;
  const a = missing[0], b = missing[missing.length - 1];
  out.push({
    id: `gaps-${a}`, prio: 1, level: 'info', icon: '🧩', key: a,
    title: 'Faltan días en el plan',
    text: (missing.length === 1
      ? `No tienes plan para el ${formatShort(a)}.`
      : `No tienes plan para ${missing.length} días entre el ${formatShort(a)} y el ${formatShort(b)}.`)
      + ' Sin plan no hay avisos: haz una foto de esos días o añádelos a mano.',
    action: { tab: 'escanear', label: 'Escanear' },
  });
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
    text: 'Para que el iPhone te avise la víspera y antes de cada turno, pide el enlace de configuración a quien te ayuda con la app.',
    action: { tab: 'ajustes', section: 'calendario', label: 'Ver cómo' },
  });
}

const TRANSIENT = ['NETWORK', 'SERVER', 'RATE_LIMIT', 'CONFLICT'];

// El calendario no se actualiza (token caducado, clave distinta…): avisar en Hoy
function syncRule(state, now, out) {
  const s = state?.settings?.sync || {};
  if (!s.enabled || !s.lastError) return;
  const transient = TRANSIENT.includes(s.lastErrorCode);
  if (transient) {
    // Fallos pasajeros (sin red…): solo si duran más de un día
    const last = Math.max(tsOf(s.lastPushAt), tsOf(s.lastPullAt));
    if (last && now.getTime() - last < 24 * 3600 * 1000) return;
  }
  out.push({
    id: 'sync-error', prio: 0, level: transient ? 'warn' : 'alert', icon: '⚠️',
    title: 'Tu calendario no se está actualizando',
    text: transient
      ? 'Hace tiempo que tus turnos no llegan al Calendario del iPhone. Abre la app con internet; si sigue igual, pide ayuda a quien te configuró la app.'
      : 'Los turnos nuevos o cambiados no llegan al Calendario del iPhone y no tendrán aviso. Pide ayuda a quien te configuró la app.',
    action: { tab: 'ajustes', section: 'calendario', label: 'Ver en Ajustes' },
  });
}

// Datos guardados por una versión más nueva de la app
function newerSchemaRule(state, out) {
  if (!state?.__newerSchema) return;
  out.push({
    id: 'newer-schema', prio: 0, level: 'alert', icon: '⬆️',
    title: 'Actualiza la app',
    text: 'Tus datos son de una versión más nueva de la app. Ciérrala del todo y vuelve a abrirla para actualizarla antes de cambiar nada.',
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
  gapsRule(state, today, out);
  freeDaysRule(state, today, out);
  remindersRule(state, out);
  syncRule(state, now, out);
  newerSchemaRule(state, out);
  return out
    .sort((a, b) => LEVEL[b.level] - LEVEL[a.level] || a.prio - b.prio || String(a.key ?? '').localeCompare(String(b.key ?? '')))
    .map(({ prio, ...rest }) => rest);
}
