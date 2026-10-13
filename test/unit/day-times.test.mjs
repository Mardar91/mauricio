// Horario especial de un día (DayEntry.times): un día puede tener otro horario para uno de sus códigos
// sin cambiar el código en todos los días. Horas, avisos, calendario, consejos, fusión e importación.
import { stateWith, memoryStorage, mockFetch, fakeGitHub, REAL_WEEK, T0, SYNC } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTimes, getDayCode, shiftInterval, timedInterval, allowsSpecialTimes, getCode } from '../../docs/js/core/codes.js';
import {
  setDay, clearDay, upsertCode, updateSettings, exportBackup, importBackup, migrateState, mergeStates, loadState,
  createStore, saveState, createDefaultState, STORAGE_KEY,
} from '../../docs/js/core/store.js';
import { dayMinutes, weekSummary, monthSummary } from '../../docs/js/core/hours.js';
import { upcomingReminders, dayTimedItems } from '../../docs/js/core/reminders.js';
import { buildICS } from '../../docs/js/core/ics.js';
import { getAdvice } from '../../docs/js/core/advice.js';
import { syncNtfy } from '../../docs/js/core/ntfy.js';
import { syncNow, pullOnly, applySyncResult, decryptBackup } from '../../docs/js/core/sync.js';

const K = '2026-10-13'; // martes, S1 en REAL_WEEK
const NOW = new Date(2026, 9, 12, 10, 0); // lun 12 oct 10:00
const T1 = new Date('2026-10-05T09:00:00Z');
const special = (s, key = K, times = { S1: { start: '15:00', end: '20:00' } }, now = T1) =>
  setDay(s, key, s.days[key].codes, { times, now });

const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
function vevent(ics, uid) {
  const ls = unfold(ics).split('\r\n');
  const i = ls.indexOf(`UID:${uid}@turnos-mauricio`);
  if (i < 0) return null;
  const end = ls.indexOf('END:VEVENT', i);
  return ls.slice(ls.lastIndexOf('BEGIN:VEVENT', i), end + 1);
}
const prop = (ev, name) => ev.find((l) => l.startsWith(name + ':') || l.startsWith(name + ';'));

// ---------- setDay y effectiveTimes ----------

test('setDay guarda un horario especial solo para ese día; el código no cambia', () => {
  const base = stateWith(REAL_WEEK);
  const s = special(base);
  assert.deepEqual(s.days[K].times, { S1: { start: '15:00', end: '20:00' } });
  assert.equal(s.days[K].updatedAt, T1.toISOString());
  assert.deepEqual(s.codes.S1, base.codes.S1); // el código S1 sigue igual
  assert.deepEqual(effectiveTimes(s, K, 'S1'), { start: '15:00', end: '20:00', breakMin: 0, special: true });
  assert.deepEqual(effectiveTimes(s, '2026-10-15', 'S1'), { start: '13:30', end: '22:00', breakMin: 30, special: false });
  // getDayCode: definición del día (confirmada, con special) — getCode sigue dando la normal
  const d = getDayCode(s, K, 'S1');
  assert.equal(d.start, '15:00');
  assert.equal(d.special, true);
  assert.equal(d.confirmed, true);
  assert.equal(getCode(s, 'S1').start, '13:30');
  assert.equal(getDayCode(s, '2026-10-15', 'S1'), getCode(s, 'S1'));
  // Sin cambios → el mismo estado
  assert.equal(special(s), s);
  assert.equal(setDay(s, K, ['S1', 'S51'], { now: T1 }), s); // sin times: se conservan
});

test('pausa del horario especial: la indicada, o la del código (0 si dura 6 h o menos y la del código es la de 30)', () => {
  const s = stateWith(REAL_WEEK);
  assert.equal(effectiveTimes(special(s, K, { S1: { start: '15:00', end: '20:00', breakMin: 15 } }), K, 'S1').breakMin, 15);
  assert.equal(effectiveTimes(special(s, K, { S1: { start: '12:00', end: '22:00' } }), K, 'S1').breakMin, 30);
  assert.equal(effectiveTimes(special(s, K, { S1: { start: '15:00', end: '21:00' } }), K, 'S1').breakMin, 0);
  // Pausa 0 explícita con el horario normal: sí es especial
  const z = special(s, K, { S1: { start: '13:30', end: '22:00', breakMin: 0 } });
  assert.deepEqual(effectiveTimes(z, K, 'S1'), { start: '13:30', end: '22:00', breakMin: 0, special: true });
  // Pausa propia del código (sin indicar la del día)
  const own = special(upsertCode(s, { code: 'S1', breakMin: 45 }, { now: T1 }), K, { S1: { start: '15:00', end: '20:00' } });
  assert.equal(effectiveTimes(own, K, 'S1').breakMin, 45);
});

test('setDay valida el horario especial y descarta lo que no aplica', () => {
  const s = stateWith(REAL_WEEK);
  assert.throws(() => special(s, K, { S1: { start: '25:00', end: '20:00' } }), /Hora de inicio no válida/);
  assert.throws(() => special(s, K, { S1: { start: '15:00', end: '' } }), /Hora de fin no válida/);
  assert.throws(() => special(s, K, { S1: { start: '15:00', end: '15:00' } }), /no puede ser la misma/);
  assert.throws(() => special(s, K, { S1: { start: '15:00', end: '20:00', breakMin: 241 } }), /pausa/);
  assert.throws(() => special(s, K, { S1: { start: '15:00', end: '20:00', breakMin: -5 } }), /pausa/);
  assert.throws(() => special(s, K, { S1: { start: '15:00', end: '20:00', breakMin: 'x' } }), /pausa/);
  assert.throws(() => special(s, K, 'S1 15:00'), /no válido/);
  assert.throws(() => special(s, K, { S1: '15:00' }), /no válido/);
  // Códigos que no están en el día, lugares y libres: se ignoran
  const t = special(s, K, { F1: { start: '07:00', end: '12:00' }, S51: { start: '07:00', end: '12:00' }, S1: { start: '9.05', end: '17:00', breakMin: '20' } });
  assert.deepEqual(t.days[K].times, { S1: { start: '09:05', end: '17:00', breakMin: 20 } });
  assert.equal(allowsSpecialTimes(getCode(s, 'S51')), false);
  assert.equal(allowsSpecialTimes(getCode(s, '-')), false);
  assert.equal(allowsSpecialTimes(getCode(s, 'TS')), true);
  // Igual que el horario normal del código → no se guarda nada
  const same = special(s, K, { S1: { start: '13:30', end: '22:00' } });
  assert.equal(same, s);
  assert.equal(s.days[K].times, undefined);
});

test('quitar el código quita su horario especial; null o {} los quita todos', () => {
  const s = special(stateWith(REAL_WEEK));
  // Añadir otro código: se conserva
  const plus = setDay(s, K, ['S1', 'S51', 'TS'], { now: T1 });
  assert.deepEqual(plus.days[K].times, s.days[K].times);
  // Cambiar S1 por F1: el horario especial de S1 se va con él
  const swapped = setDay(s, K, ['F1', 'S51'], { now: T1 });
  assert.equal(swapped.days[K].times, undefined);
  assert.equal(effectiveTimes(swapped, K, 'F1').special, false);
  // Volver a poner S1 no lo recupera
  assert.equal(setDay(swapped, K, ['S1', 'S51'], { now: T1 }).days[K].times, undefined);
  for (const times of [null, {}]) {
    const cleared = setDay(s, K, ['S1', 'S51'], { times, now: T1 });
    assert.equal(cleared.days[K].times, undefined);
    assert.equal(effectiveTimes(cleared, K, 'S1').special, false);
  }
  // Borrar el día lo borra todo; volver a escribirlo empieza sin horario especial
  const del = clearDay(s, K, { now: T1 });
  assert.equal(setDay(del, K, ['S1'], { now: T1 }).days[K].times, undefined);
  // Un escaneo con el mismo código no lo toca (el plan no trae horas)
  assert.deepEqual(setDay(s, K, ['S1', 'S51'], { source: 'scan', now: T1 }).days[K].times, s.days[K].times);
});

// ---------- Intervalos y horas ----------

test('intervalos: el horario especial manda (también si pasa de medianoche)', () => {
  let s = special(stateWith(REAL_WEEK));
  assert.deepEqual(shiftInterval(s, K, 'S1'), { start: new Date(2026, 9, 13, 15, 0), end: new Date(2026, 9, 13, 20, 0) });
  assert.equal(timedInterval(s, K, 'S1').start.getTime(), new Date(2026, 9, 13, 15, 0).getTime());
  s = special(s, K, { S1: { start: '18:00', end: '02:00' } });
  assert.deepEqual(shiftInterval(s, K, 'S1'), { start: new Date(2026, 9, 13, 18, 0), end: new Date(2026, 9, 14, 2, 0) });
  // Noche del cambio de hora (25 oct): 22:00–06:00 son 9 h reales
  const dst = setDay(stateWith({ '2026-10-24': ['Z1'] }), '2026-10-24', ['Z1'], { times: { Z1: { start: '22:00', end: '06:00' } }, now: T1 });
  assert.equal(dayMinutes(dst, '2026-10-24').worked, 9 * 60 - 30);
});

test('horas del día, de la semana y del mes con el horario especial', () => {
  const base = stateWith(REAL_WEEK);
  const s = special(base);
  assert.equal(dayMinutes(base, K).worked, 480);
  assert.deepEqual(dayMinutes(s, K).items[0], { code: 'S1', minutes: 300, type: 'worked', special: true });
  assert.equal(dayMinutes(s, K).total, 300);
  const wb = weekSummary(base, '2026-10-12'), ws = weekSummary(s, '2026-10-12');
  assert.equal(ws.total, wb.total - 180);
  const mb = monthSummary(base, 2026, 10), ms = monthSummary(s, 2026, 10);
  assert.equal(ms.total, mb.total - 180);
  assert.equal(ms.shifts, mb.shifts);
  // Noches: un Z1 especial de 22:00 a 06:00 cuenta como noche; un N1 especial de día, no
  const n = setDay(setDay(s, '2026-10-14', ['Z1'], { times: { Z1: { start: '22:00', end: '06:00' } }, now: T1 }),
    '2026-10-17', ['N1', 'N51'], { times: { N1: { start: '08:00', end: '16:00' } }, now: T1 });
  assert.equal(monthSummary(n, 2026, 10).nights, mb.nights); // +1 (Z1) −1 (N1 de día)
  assert.equal(dayMinutes(n, '2026-10-17').worked, 450);
  // Un evento sin horario (TS) con horario especial: tiene hora, pero no cuenta horas (countsHours false)
  const ts = setDay(s, '2026-10-14', ['TS'], { times: { TS: { start: '14:00', end: '15:30' } }, now: T1 });
  assert.equal(dayMinutes(ts, '2026-10-14').worked, 0);
  assert.equal(dayTimedItems(ts, '2026-10-14')[0].special, true);
});

// ---------- Avisos, ntfy y calendario ----------

test('recordatorios a la hora especial (mismos ids)', () => {
  const s = special(stateWith(REAL_WEEK));
  const rem = upcomingReminders(s, NOW, 48 * 3600 * 1000).filter((r) => r.key === K);
  assert.deepEqual(rem.map((r) => r.id), [`${K}-S1-eve`, `${K}-S1-pre`]);
  assert.equal(rem[0].at.getTime(), new Date(2026, 9, 12, 20, 0).getTime());
  assert.match(rem[0].title, /Mañana trabajas: 15:00–20:00 \(S1\)/);
  assert.equal(rem[1].at.getTime(), new Date(2026, 9, 13, 14, 0).getTime());
  assert.match(rem[1].title, /\(15:00\)/);
  // Un evento sin hora con horario especial ya avisa
  const ts = setDay(s, K, ['TS', 'S1'], { times: { TS: { start: '09:00', end: '10:00' } }, now: T1 });
  assert.ok(upcomingReminders(ts, NOW, 48 * 3600 * 1000).some((r) => r.id === `${K}-TS-pre`));
});

test('ntfy: el aviso con la hora nueva sustituye al programado (mismo sequence_id)', async () => {
  const s0 = updateSettings(stateWith(REAL_WEEK), { ntfy: { enabled: true, topic: 'turnos-mauricio-abcdef123456' } });
  const f0 = mockFetch(() => ({ status: 200, body: {} }));
  const r0 = await syncNtfy(s0, NOW, f0, { appUrl: undefined });
  const s1 = updateSettings(special(s0), { ntfy: { scheduled: r0.scheduled } });
  const f1 = mockFetch(() => ({ status: 200, body: {} }));
  const r1 = await syncNtfy(s1, NOW, f1, { appUrl: undefined });
  assert.deepEqual(r1.published.filter((x) => x.startsWith(K)).sort(), [`${K}-S1-eve`, `${K}-S1-pre`]);
  const pre = f1.calls.map((c) => c.json()).find((p) => p.sequence_id === `${K}-S1-pre`);
  assert.equal(pre.delay, String(new Date(2026, 9, 13, 14, 0).getTime() / 1000));
  assert.deepEqual(r1.cancelled, []);
  // Sin cambios: no se vuelve a enviar nada
  const f2 = mockFetch(() => ({ status: 200, body: {} }));
  const r2 = await syncNtfy(updateSettings(s1, { ntfy: { scheduled: r1.scheduled } }), NOW, f2, { appUrl: undefined });
  assert.deepEqual(r2.published, []);
});

test('calendario: evento a la hora especial, alarmas recalculadas y SEQUENCE/DTSTAMP estables', () => {
  const base = stateWith(REAL_WEEK);
  const s = special(base);
  const a = buildICS(base, { now: NOW }), b = buildICS(s, { now: NOW });
  const ev = vevent(b, `${K}-S1`);
  assert.equal(prop(ev, 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261013T150000');
  assert.equal(prop(ev, 'DTEND'), 'DTEND;TZID=Europe/Berlin:20261013T200000');
  assert.match(prop(ev, 'DESCRIPTION'), /Horario: 15:00–20:00/);
  assert.match(prop(ev, 'DESCRIPTION'), /Horario especial de este día/);
  assert.doesNotMatch(prop(ev, 'DESCRIPTION'), /Pausa/); // 5 h: sin pausa
  assert.deepEqual(ev.filter((l) => l.startsWith('TRIGGER:')), ['TRIGGER:-PT19H', 'TRIGGER:-PT1H']);
  assert.ok(ev.some((l) => /a las 15:00/.test(l)));
  // Solo cambia el evento de ese día; su sello sube y los demás quedan igual
  const seq = (ics, uid) => Number(prop(vevent(ics, uid), 'SEQUENCE').slice(9));
  assert.ok(seq(b, `${K}-S1`) > seq(a, `${K}-S1`));
  assert.equal(prop(vevent(b, `${K}-S1`), 'DTSTAMP'), 'DTSTAMP:20261005T090000Z');
  for (const uid of ['2026-10-12-F1', '2026-10-15-S1', '2026-10-17-N1']) assert.deepEqual(vevent(b, uid), vevent(a, uid));
  // El mismo contenido da siempre el mismo calendario
  assert.equal(buildICS(s, { now: NOW }), b);
  assert.equal(buildICS(s, { now: new Date(2026, 9, 20, 12, 0) }), b);
  // Quitar el horario especial más tarde: vuelve al normal y la SEQUENCE no retrocede
  const back = setDay(s, K, ['S1', 'S51'], { times: null, now: new Date('2026-10-06T09:00:00Z') });
  const c = buildICS(back, { now: NOW });
  assert.equal(prop(vevent(c, `${K}-S1`), 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261013T133000');
  assert.ok(seq(c, `${K}-S1`) > seq(b, `${K}-S1`));
  // Un evento sin hora (TS) con horario especial deja de ser de día completo
  const ts = setDay(s, '2026-10-14', ['TS'], { times: { TS: { start: '14:00', end: '15:30' } }, now: T1 });
  const tev = vevent(buildICS(ts, { now: NOW }), '2026-10-14-TS');
  assert.equal(prop(tev, 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261014T140000');
});

// ---------- Consejos ----------

test('consejos: descanso, solapes y noches con el horario especial', () => {
  const now = new Date(2026, 9, 19, 8, 0);
  // S1 (termina 22:00) y F1 al día siguiente (06:00): 8 h de descanso → aviso
  const base = stateWith({ '2026-10-20': ['S1'], '2026-10-21': ['F1'] });
  assert.ok(getAdvice(base, now).find((a) => a.id === 'rest-2026-10-21-F1'));
  // S1 especial que termina a las 17:00 → 13 h: sin aviso
  const early = setDay(base, '2026-10-20', ['S1'], { times: { S1: { start: '09:00', end: '17:00' } }, now: T1 });
  assert.equal(getAdvice(early, now).find((a) => a.id.startsWith('rest-')), undefined);
  // F1 especial que empieza a las 08:00 → 10 h: sigue el aviso, con las horas reales
  const late = setDay(base, '2026-10-21', ['F1'], { times: { F1: { start: '08:00', end: '16:00' } }, now: T1 });
  assert.match(getAdvice(late, now).find((a) => a.id === 'rest-2026-10-21-F1').text, /10 h de descanso/);
  // N1 (termina 06:00) y un F1 especial que empieza a las 05:00 → se cruzan
  const n = stateWith({ '2026-10-20': ['N1'], '2026-10-21': ['F1'] });
  const overlap = setDay(n, '2026-10-21', ['F1'], { times: { F1: { start: '05:00', end: '13:00' } }, now: T1 });
  const o = getAdvice(overlap, now).find((a) => a.id === 'overlap-2026-10-21-F1');
  assert.equal(o.level, 'alert');
  assert.match(o.text, /empieza a las 05:00/);
  // Noche especial (Z1 de 22:00 a 06:00) → consejo de noches
  const z = setDay(stateWith({ '2026-10-20': ['Z1'] }), '2026-10-20', ['Z1'], { times: { Z1: { start: '22:00', end: '06:00' } }, now: T1 });
  assert.ok(getAdvice(z, now).find((a) => a.id === 'nights-2026-10-20'));
  // Un F6 (sin confirmar) con horario especial ese día no pide confirmar el horario
  const f6 = stateWith({ '2026-10-20': ['F6'] });
  assert.ok(getAdvice(f6, now).find((a) => a.id === 'unconfirmed-F6'));
  const f6s = setDay(f6, '2026-10-20', ['F6'], { times: { F6: { start: '07:00', end: '15:00' } }, now: T1 });
  assert.equal(getAdvice(f6s, now).find((a) => a.id === 'unconfirmed-F6'), undefined);
});

// ---------- Guardar, cargar, exportar, importar, fusionar ----------

test('se guarda y se carga; lo inválido se descarta al cargar', () => {
  const s = special(stateWith(REAL_WEEK));
  const st = memoryStorage();
  assert.equal(saveState(s, st), true);
  assert.deepEqual(loadState(st).days[K].times, s.days[K].times);
  const store = createStore(st, { target: null });
  assert.deepEqual(store.get().days[K].times, s.days[K].times);
  const raw = JSON.parse(st.getItem(STORAGE_KEY));
  // S1: pausa fuera de rango → sin pausa · F1: no está en el día · S51: hora inválida · __proto__: clave peligrosa
  raw.days[K].times = JSON.parse(`{"S1":{"start":"15:00","end":"20:00","breakMin":999,"extra":"x"},
    "F1":{"start":"07:00","end":"12:00"},"S51":{"start":"x","end":"12:00"},"__proto__":{"start":"01:00","end":"02:00"}}`);
  raw.days['2026-10-17'].times = { N1: { start: '22:00', end: '22:00' } }; // 24 h: no vale
  assert.ok(Object.keys(raw.days[K].times).includes('__proto__'));
  raw.days['2026-10-15'].times = 'basura';
  const m = migrateState(raw);
  assert.deepEqual(m.days[K].times, { S1: { start: '15:00', end: '20:00' } });
  assert.equal('times' in m.days['2026-10-15'], false);
  assert.equal('times' in m.days['2026-10-17'], false);
});

test('exportar e importar conservan el horario especial', () => {
  const s = special(stateWith(REAL_WEEK));
  const file = exportBackup(s, { now: T1 });
  assert.deepEqual(JSON.parse(file).days[K].times, s.days[K].times);
  const fresh = importBackup(createDefaultState(), file, { now: T1 });
  assert.deepEqual(fresh.days[K].times, s.days[K].times);
  assert.equal(effectiveTimes(fresh, K, 'S1').start, '15:00');
  // Teléfono conectado con el mismo día SIN horario especial: lo importado es distinto → se sella
  const now = new Date('2026-10-07T09:00:00Z');
  const phone = updateSettings(stateWith(REAL_WEEK), { sync: { enabled: true, lastPullAt: T0.toISOString() } });
  const imp = importBackup(phone, file, { now });
  assert.deepEqual(imp.days[K].times, s.days[K].times);
  assert.equal(imp.days[K].updatedAt, now.toISOString());
  assert.equal(imp.days['2026-10-15'].updatedAt, phone.days['2026-10-15'].updatedAt); // idéntico: no se sella
});

test('fusión entre dispositivos: el día es la unidad (gana el más reciente, con o sin horario especial)', () => {
  const base = stateWith(REAL_WEEK);
  const withTimes = special(base, K, undefined, new Date('2026-10-05T09:00:00Z'));
  const later = setDay(base, K, ['S1', 'S51'], { note: 'cambio', now: new Date('2026-10-06T09:00:00Z') });
  // Remoto más nuevo con horario especial → llega
  let m = mergeStates(base, withTimes, { now: NOW });
  assert.deepEqual(m.state.days[K].times, withTimes.days[K].times);
  assert.deepEqual(m.pulledDays, [K]);
  // Local más nuevo sin horario especial → se queda sin él
  m = mergeStates(later, withTimes, { now: NOW });
  assert.equal(m.state.days[K].times, undefined);
  assert.equal(m.state.days[K].note, 'cambio');
  // Mismo sello, distinto contenido → determinista en los dos sentidos
  const t = new Date('2026-10-05T09:00:00Z');
  const other = special(base, K, { S1: { start: '16:00', end: '21:00' } }, t);
  assert.deepEqual(mergeStates(withTimes, other, { now: NOW }).state.days[K], mergeStates(other, withTimes, { now: NOW }).state.days[K]);
});

test('sincronización: el horario especial se publica, llega al que solo lee y no cuenta como cambio sin publicar', async () => {
  const gh = fakeGitHub();
  const at = (h) => new Date(T0.getTime() + h * 3600 * 1000);
  let A = updateSettings(stateWith(REAL_WEEK), { sync: { ...SYNC, deviceId: 'iphone' } });
  let r = await syncNow(A, { fetchImpl: gh.fetch, now: at(1) });
  A = applySyncResult(A, r, { now: at(1) });
  let B = updateSettings(createDefaultState(), { sync: { ...SYNC, deviceId: 'safari' } });
  B = applySyncResult(B, await pullOnly(B, { fetchImpl: gh.fetch, now: at(2) }), { now: at(2) });
  // A pone un horario especial y publica: copia nueva y calendario con la hora nueva
  A = special(A, K, undefined, at(3));
  r = await syncNow(A, { fetchImpl: gh.fetch, now: at(3) });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.pushed, true);
  assert.equal(r.icsPushed, true);
  A = applySyncResult(A, r, { now: at(3) });
  assert.deepEqual((await decryptBackup(JSON.parse(gh.text('backup.json')), SYNC.key)).days[K].times, A.days[K].times);
  assert.match(unfold(gh.text('turnos.ics')), /DTSTART;TZID=Europe\/Berlin:20261013T150000/);
  // Sin cambios: nada que publicar
  assert.equal((await syncNow(A, { fetchImpl: gh.fetch, now: at(4) })).pushed, false);
  // B lee: le llega, y no tiene nada «sin publicar»
  const rb = await pullOnly(B, { fetchImpl: gh.fetch, now: at(5) });
  assert.equal(rb.readOnly, true);
  assert.deepEqual(rb.unpublishedDays, []);
  B = applySyncResult(B, rb, { now: at(5) });
  assert.deepEqual(B.days[K].times, A.days[K].times);
  assert.equal(B.settings.sync.unpublished, 0);
  // Si B cambia solo el horario especial, eso sí es un cambio sin publicar
  const B2 = special(B, K, { S1: { start: '16:00', end: '20:00' } }, at(6));
  const rb2 = await syncNow(B2, { fetchImpl: gh.fetch, now: at(6) });
  assert.equal(rb2.readOnly, true);
  assert.deepEqual(rb2.unpublishedDays, [K]);
});
