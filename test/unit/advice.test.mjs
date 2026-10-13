import { stateWith, REAL_WEEK } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdvice } from '../../docs/js/core/advice.js';
import { setDay, updateSettings, upsertCode } from '../../docs/js/core/store.js';

const NOW = new Date(2026, 9, 12, 8, 0); // lunes 12 oct 2026, 08:00
const ids = (list) => list.map((a) => a.id);
const find = (list, prefix) => list.find((a) => a.id.startsWith(prefix));

test('forma de cada consejo', () => {
  const list = getAdvice(stateWith(REAL_WEEK), NOW);
  assert.ok(list.length > 0);
  for (const a of list) {
    assert.equal(typeof a.id, 'string');
    assert.ok(['info', 'warn', 'alert'].includes(a.level));
    assert.equal(typeof a.icon, 'string');
    assert.ok(a.title.length > 0 && a.text.length > 0);
    assert.equal(a.prio, undefined);
  }
});

test('regla 1: S1 y F1 al día siguiente → solo 8 h de descanso (warn)', () => {
  const list = getAdvice(stateWith({ '2026-10-13': ['S1'], '2026-10-14': ['F1'] }), NOW);
  const a = find(list, 'rest-');
  assert.ok(a, ids(list).join());
  assert.equal(a.level, 'warn');
  assert.equal(a.key, '2026-10-14');
  assert.match(a.text, /8 h de descanso/);
  assert.match(a.text, /S1/);
  assert.match(a.text, /F1/);
});

test('regla 1: 11 h o más de descanso no avisa', () => {
  const list = getAdvice(stateWith({ '2026-10-13': ['F1'], '2026-10-14': ['F1'] }), NOW);
  assert.equal(find(list, 'rest-'), undefined);
});

test('regla 2: N1 que termina a las 06:00 y F1 a las 06:00 ese día → alerta', () => {
  const list = getAdvice(stateWith({ '2026-10-13': ['N1'], '2026-10-14': ['F1'] }), NOW);
  const a = find(list, 'overlap-');
  assert.ok(a);
  assert.equal(a.level, 'alert');
  assert.equal(list[0].id, a.id); // lo más importante primero
  assert.equal(find(list, 'rest-'), undefined);
});

test('regla 3: 6 días seguidos → warn; 8 → alert', () => {
  const six = {};
  for (let d = 12; d <= 17; d++) six[`2026-10-${d}`] = ['F1'];
  let a = find(getAdvice(stateWith(six), NOW), 'streak-');
  assert.equal(a.level, 'warn');
  assert.match(a.title, /6 días seguidos/);
  const eight = { ...six, '2026-10-18': ['F1'], '2026-10-19': ['F1'] };
  a = find(getAdvice(stateWith(eight), NOW), 'streak-');
  assert.equal(a.level, 'alert');
  assert.match(a.title, /8 días/);
  const five = { '2026-10-12': ['F1'], '2026-10-13': ['F1'], '2026-10-14': ['F1'], '2026-10-15': ['F1'], '2026-10-16': ['F1'] };
  assert.equal(find(getAdvice(stateWith(five), NOW), 'streak-'), undefined);
});

test('regla 4: semana pesada (39 h 30 > 35 + 4) y semana tranquila', () => {
  const heavy = find(getAdvice(stateWith(REAL_WEEK), NOW), 'week-heavy-2026-10-12');
  assert.ok(heavy);
  assert.equal(heavy.level, 'warn');
  assert.match(heavy.text, /39 h 30/);
  const light = {
    '2026-10-12': ['F1'], '2026-10-13': ['-'], '2026-10-14': ['-'], '2026-10-15': ['S1'],
    '2026-10-16': ['-'], '2026-10-17': ['-'], '2026-10-18': ['-'],
  };
  const a = find(getAdvice(stateWith(light), NOW), 'week-light-');
  assert.equal(a.level, 'info');
  // Con vacaciones no se considera "tranquila"
  const vac = { ...light, '2026-10-13': ['U'], '2026-10-14': ['U'] };
  assert.equal(find(getAdvice(stateWith(vac), NOW), 'week-light-'), undefined);
  // La próxima semana también se revisa
  const next = {};
  for (const [k, v] of Object.entries(REAL_WEEK)) next[k.replace(/-1(\d)$/, (m, d) => `-${19 + Number(d) - 2}`)] = v;
  assert.ok(find(getAdvice(stateWith(next), NOW), 'week-heavy-2026-10-19'));
});

test('regla 5: balance del mes', () => {
  const a = find(getAdvice(stateWith(REAL_WEEK), NOW), 'month-2026-10');
  assert.equal(a.level, 'info');
  assert.match(a.text, /39 h 30/);
  assert.match(a.text, /154 h/);
});

test('regla 6: bloque de noches próximo', () => {
  const s = stateWith({ '2026-10-13': ['N1'], '2026-10-14': ['N1'], '2026-10-15': ['-'] });
  const a = find(getAdvice(s, NOW), 'nights-2026-10-13');
  assert.ok(a);
  assert.equal(a.level, 'info');
  assert.match(a.title, /2 noches/);
  assert.match(a.text, /no conduzcas/);
  assert.equal(find(getAdvice(stateWith({ '2026-10-20': ['N1'] }), NOW), 'nights-'), undefined); // demasiado lejos
});

test('regla 7: horario sin confirmar (F6)', () => {
  const s = stateWith({ '2026-10-15': ['F6', 'F52'], '2026-10-16': ['F6'] });
  const a = find(getAdvice(s, NOW), 'unconfirmed-F6');
  assert.equal(a.level, 'warn');
  assert.equal(a.key, '2026-10-15');
  assert.match(a.title, /Confirma el horario de F6/);
  assert.match(a.text, /06:00–15:00/);
  const confirmed = upsertCode(s, { code: 'F6', confirmed: true });
  assert.equal(find(getAdvice(confirmed, NOW), 'unconfirmed-'), undefined);
  // Código nuevo: turno por analogía y código desconocido
  const fresh = getAdvice(stateWith({ '2026-10-13': ['F4'], '2026-10-14': ['K'] }), NOW);
  assert.match(find(fresh, 'unconfirmed-F4').title, /Confirma el horario de F4/);
  assert.match(find(fresh, 'unconfirmed-K').title, /Código nuevo: K/);
});

test('regla 8: faltan datos', () => {
  const empty = find(getAdvice(stateWith(), NOW), 'missing-data');
  assert.equal(empty.level, 'info');
  assert.match(empty.text, /foto/);
  const s = stateWith({ '2026-10-12': ['F1'], '2026-10-18': ['F1'] });
  assert.ok(find(getAdvice(s, NOW), 'missing-data'));
  const s2 = stateWith({ '2026-10-12': ['F1'], '2026-10-19': ['F1'] });
  assert.equal(find(getAdvice(s2, NOW), 'missing-data'), undefined);
});

test('regla 9: días libres seguidos', () => {
  const s = stateWith({ '2026-10-12': ['F1'], '2026-10-13': ['-'], '2026-10-14': ['W-'], '2026-10-15': ['S1'] });
  const a = find(getAdvice(s, NOW), 'free-2026-10-13');
  assert.equal(a.level, 'info');
  assert.match(a.text, /2 días libres/);
  const single = stateWith({ '2026-10-12': ['F1'], '2026-10-13': ['-'], '2026-10-14': ['S1'] });
  assert.equal(find(getAdvice(single, NOW), 'free-'), undefined);
});

test('regla 10: recordatorios no activados', () => {
  const s = stateWith(REAL_WEEK);
  const a = find(getAdvice(s, NOW), 'reminders-off');
  assert.equal(a.level, 'info');
  assert.equal(a.action.tab, 'ajustes');
  assert.equal(find(getAdvice(updateSettings(s, { sync: { enabled: true } }), NOW), 'reminders-off'), undefined);
  assert.equal(find(getAdvice(updateSettings(s, { ntfy: { enabled: true } }), NOW), 'reminders-off'), undefined);
});

test('orden: alert > warn > info', () => {
  const s = stateWith({ ...REAL_WEEK, '2026-10-13': ['N1'], '2026-10-14': ['F1'], '2026-10-16': ['F6'] });
  const levels = getAdvice(s, NOW).map((a) => a.level);
  const rank = { alert: 3, warn: 2, info: 1 };
  for (let i = 1; i < levels.length; i++) assert.ok(rank[levels[i - 1]] >= rank[levels[i]], levels.join());
  assert.equal(levels[0], 'alert');
});

test('C5: una reunión o un código desconocido no es día libre; un evento con hora cuenta para la racha', () => {
  const s = stateWith({ '2026-10-13': ['F1'], '2026-10-14': ['TS'], '2026-10-15': ['-'], '2026-10-16': ['F1'] });
  assert.equal(find(getAdvice(s, NOW), 'free-'), undefined);
  const unknown = stateWith({ '2026-10-13': ['FB'], '2026-10-14': ['-'], '2026-10-15': ['F1'] });
  assert.equal(find(getAdvice(unknown, NOW), 'free-'), undefined);
  // Racha: 5 turnos + una reunión con hora = 6 días seguidos
  let streak = {};
  for (let d = 12; d <= 17; d++) streak[`2026-10-${d}`] = d === 14 ? ['TS'] : ['F1'];
  let st = upsertCode(stateWith(streak), { code: 'TS', start: '14:00', end: '15:00' });
  assert.match(find(getAdvice(st, NOW), 'streak-').title, /6 días seguidos/);
  // Sin hora la reunión no cuenta como día trabajado
  assert.equal(find(getAdvice(stateWith(streak), NOW), 'streak-'), undefined);
});

test('C7: huecos sin plan en los próximos 7 días → "Faltan días en el plan"', () => {
  const days = { '2026-10-12': ['F1'], '2026-10-13': ['S1'] };
  for (let d = 17; d <= 31; d++) days[`2026-10-${d}`] = ['F1'];
  const a = find(getAdvice(stateWith(days), NOW), 'gaps-');
  assert.ok(a);
  assert.equal(a.id, 'gaps-2026-10-14');
  assert.equal(a.level, 'info');
  assert.equal(a.title, 'Faltan días en el plan');
  assert.match(a.text, /3 días entre el mié 14 oct y el vie 16 oct/);
  assert.equal(a.action.tab, 'escanear');
  // Plan completo: sin aviso
  const full = {};
  for (let d = 12; d <= 31; d++) full[`2026-10-${d}`] = ['F1'];
  assert.equal(find(getAdvice(stateWith(full), NOW), 'gaps-'), undefined);
  // Un solo día
  const one = { ...full };
  delete one['2026-10-15'];
  assert.match(find(getAdvice(stateWith(one), NOW), 'gaps-').text, /No tienes plan para el jue 15 oct\./);
});

test('C11: antes de la primera noche "Se acerca un bloque de noches"; después "Estás en"', () => {
  const s = stateWith({ '2026-10-13': ['N1'], '2026-10-14': ['N1'] });
  const before = find(getAdvice(s, new Date(2026, 9, 13, 9, 0)), 'nights-');
  assert.match(before.text, /^Se acerca un bloque de noches/);
  const during = find(getAdvice(s, new Date(2026, 9, 13, 23, 0)), 'nights-');
  assert.match(during.text, /^Estás en un bloque de noches/);
  const single = stateWith({ '2026-10-13': ['N1'] });
  assert.match(find(getAdvice(single, new Date(2026, 9, 13, 9, 0)), 'nights-').text, /^Esta noche trabajas/);
  assert.match(find(getAdvice(single, NOW), 'nights-').text, /^Se acerca un turno de noche/);
});

test('U13: el consejo de recordatorios no promete minutos y lleva a la sección del calendario', () => {
  const a = find(getAdvice(stateWith(REAL_WEEK), NOW), 'reminders-off');
  assert.doesNotMatch(a.text, /minuto/);
  assert.match(a.text, /enlace de configuración/);
  assert.deepEqual({ tab: a.action.tab, section: a.action.section }, { tab: 'ajustes', section: 'calendar' }); // id #set-calendar
});

test('U4: si el calendario no se actualiza, aviso en Hoy (pasajeros solo si duran)', () => {
  const base = stateWith(REAL_WEEK);
  const auth = updateSettings(base, { sync: { enabled: true, lastError: 'La conexión del calendario ha caducado.', lastErrorCode: 'AUTH', lastPushAt: NOW.toISOString() } });
  const a = find(getAdvice(auth, NOW), 'sync-error');
  assert.equal(a.level, 'alert');
  assert.equal(a.title, 'Tu calendario no se está actualizando');
  assert.doesNotMatch(a.text, /token/i);
  assert.deepEqual([a.action.tab, a.action.section], ['ajustes', 'calendar']);
  assert.equal(getAdvice(auth, NOW)[0].id, 'sync-error');
  const recent = updateSettings(base, { sync: { enabled: true, lastError: 'Sin conexión', lastErrorCode: 'NETWORK', lastPushAt: new Date(NOW.getTime() - 3600e3).toISOString() } });
  assert.equal(find(getAdvice(recent, NOW), 'sync-error'), undefined);
  const old = updateSettings(recent, { sync: { lastPushAt: new Date(NOW.getTime() - 3 * 24 * 3600e3).toISOString() } });
  assert.equal(find(getAdvice(old, NOW), 'sync-error').level, 'warn');
  assert.equal(find(getAdvice(updateSettings(auth, { sync: { enabled: false } }), NOW), 'sync-error'), undefined);
});

test('datos de una versión más nueva → "Actualiza la app"', () => {
  const s = { ...stateWith(REAL_WEEK), __newerSchema: true };
  assert.equal(find(getAdvice(s, NOW), 'newer-schema').level, 'alert');
});

test('sync-error: el primer fallo pasajero sin haber conectado nunca da un aviso suave', () => {
  const base = stateWith(REAL_WEEK);
  const never = updateSettings(base, { sync: { enabled: true, lastError: 'Sin conexión', lastErrorCode: 'NETWORK', lastErrorSince: NOW.toISOString() } });
  const a = find(getAdvice(never, NOW), 'sync-error');
  assert.equal(a.level, 'info');
  assert.match(a.text, /Todavía no se ha podido conectar el calendario/);
  assert.doesNotMatch(a.text, /Hace tiempo/);
  assert.deepEqual([a.action.tab, a.action.section], ['ajustes', 'calendar']);
  // Un error no pasajero sigue siendo una alerta aunque nunca haya conectado
  const auth = updateSettings(never, { sync: { lastErrorCode: 'AUTH', lastError: 'caducado' } });
  assert.equal(find(getAdvice(auth, NOW), 'sync-error').level, 'alert');
});

test('sync-error: lo que cuenta es desde cuándo falla (lastErrorSince), no la última vez que fue bien', () => {
  const H = 3600e3;
  const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
  // Sin abrir la app 3 días; falla desde hace 1 h → todavía nada
  const s = updateSettings(stateWith(REAL_WEEK), { sync: { enabled: true, lastError: 'Sin conexión', lastErrorCode: 'NETWORK', lastPushAt: ago(72 * H), lastErrorSince: ago(H) } });
  assert.equal(find(getAdvice(s, NOW), 'sync-error'), undefined);
  // Falla desde hace 2 días → aviso
  const old = updateSettings(s, { sync: { lastErrorSince: ago(48 * H) } });
  assert.equal(find(getAdvice(old, NOW), 'sync-error').level, 'warn');
});

test('la baja por enfermedad no es «días libres a la vista»', () => {
  let t = stateWith({});
  t = upsertCode(t, { code: 'K', kind: 'sick', name: 'Enfermo' });
  for (const d of ['2026-10-13', '2026-10-14', '2026-10-15']) t = setDay(t, d, ['K']);
  assert.equal(find(getAdvice(t, NOW), 'free-'), undefined);
  // Las vacaciones sí
  const v = stateWith({ '2026-10-13': ['U'], '2026-10-14': ['U'] });
  assert.match(find(getAdvice(v, NOW), 'free-').title, /Vacaciones/);
});

test('read-only: si otro dispositivo publica y aquí hay cambios sin publicar, se avisa', () => {
  const pulled = new Date(NOW.getTime() - 3600e3).toISOString();
  const sync = { enabled: true, deviceId: 'safari', publisher: 'app', lastPullAt: pulled };
  const clean = updateSettings(stateWith(REAL_WEEK), { sync });
  // Datos de antes de la última lectura: nada que avisar
  assert.equal(find(getAdvice(clean, NOW), 'read-only'), undefined);
  // Un cambio hecho aquí después de leer
  const edited = { ...clean, days: { ...clean.days, '2026-10-20': { codes: ['F1'], note: '', source: 'manual', updatedAt: NOW.toISOString() } } };
  const a = find(getAdvice(edited, NOW), 'read-only');
  assert.equal(a.level, 'warn');
  assert.match(a.text, /Usar este dispositivo/);
  assert.deepEqual([a.action.tab, a.action.section], ['ajustes', 'calendar']);
  // O días sin publicar según la última sincronización
  assert.ok(find(getAdvice(updateSettings(clean, { sync: { unpublished: 2 } }), NOW), 'read-only'));
  // Si este dispositivo es el que publica, nada
  assert.equal(find(getAdvice(updateSettings(edited, { sync: { publisher: 'safari' } }), NOW), 'read-only'), undefined);
});
