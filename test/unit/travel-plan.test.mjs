import { stateWith, mockFetch } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayTravel, mapsUrl, travelOf } from '../../docs/js/core/codes.js';
import { buildICS, calendarName, uidDomain } from '../../docs/js/core/ics.js';
import { syncNtfy } from '../../docs/js/core/ntfy.js';
import { dayTimedItems, planUploadReminder, travelText, upcomingReminders } from '../../docs/js/core/reminders.js';
import { icsEventCount } from '../../docs/js/core/sync.js';
import { createDefaultState, exportBackup, importBackup, setDay, updateSettings, upsertCode } from '../../docs/js/core/store.js';

const NOW = new Date(2026, 9, 12, 10, 0); // lunes 12 oct 2026
const DAY = 24 * 3600 * 1000;

const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
// VEVENT (líneas desplegadas) con ese UID
function vevent(ics, uid) {
  const blocks = unfold(ics).split('BEGIN:VEVENT').slice(1).map((b) => b.split('END:VEVENT')[0].split('\r\n').filter(Boolean));
  return blocks.find((ls) => ls.includes(`UID:${uid}`));
}
const prop = (ev, name) => ev?.find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
const alarms = (ev) => {
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    if (ev[i] !== 'BEGIN:VALARM') continue;
    const end = ev.indexOf('END:VALARM', i);
    const a = ev.slice(i, end);
    out.push({ trigger: prop(a, 'TRIGGER').slice(8), text: prop(a, 'DESCRIPTION').slice(12) });
  }
  return out;
};

// Tarde S1 (13:30) en F51, a 25 min de casa
function travelState() {
  let s = stateWith({ '2026-10-13': ['S1', 'F51'], '2026-10-14': ['F1'] });
  s = upsertCode(s, { code: 'F51', place: 'Karl-Marx-Str. 1, Berlin', travelMin: 25 }, { now: NOW });
  return s;
}

// ---------- Tiempo de viaje (§13.2) ----------

test('travelMin: saneado 0–180 y viaje del día = el mayor de sus códigos', () => {
  let s = createDefaultState();
  assert.equal(s.codes.F51.travelMin, 0);
  for (const [v, want] of [[500, 180], [-5, 0], ['30', 30], [12.6, 13], ['x', 0]]) {
    assert.equal(upsertCode(s, { code: 'F51', travelMin: v }).codes.F51.travelMin, want, String(v));
  }
  assert.equal(travelOf({ travelMin: 999 }), 180);
  s = travelState();
  assert.deepEqual(dayTravel(s, '2026-10-13').minutes, 25);
  assert.equal(dayTravel(s, '2026-10-13').to.code, 'F51');
  assert.equal(dayTravel(s, '2026-10-14').minutes, 0);
  assert.equal(dayTravel(s, '2026-10-30').minutes, 0); // sin plan
  // El turno también puede tener viaje: gana el mayor; el destino es el lugar del día
  s = upsertCode(s, { code: 'S1', travelMin: 40 });
  assert.deepEqual([dayTravel(s, '2026-10-13').minutes, dayTravel(s, '2026-10-13').code, dayTravel(s, '2026-10-13').to.code], [40, 'S1', 'F51']);
  // Viaje en la copia de seguridad
  const back = importBackup(createDefaultState(), exportBackup(s));
  assert.equal(back.codes.F51.travelMin, 25);
  assert.equal(back.codes.S1.travelMin, 40);
});

test('recordatorio «antes del turno»: inicio − viaje − minutesBefore con «Sal a las …»', () => {
  const s = travelState();
  const [item] = dayTimedItems(s, '2026-10-13');
  assert.equal(item.travelMin, 25);
  assert.equal(item.travelTo, 'F51');
  assert.equal(item.leaveAt.getTime(), new Date(2026, 9, 13, 13, 5).getTime());
  assert.equal(travelText(item), 'Sal a las 13:05 hacia F51 (25 min de viaje)');
  assert.equal(travelText(item, { places: false }), 'Sal a las 13:05 (25 min de viaje)');
  const rems = upcomingReminders(s, NOW, 3 * DAY);
  const pre = rems.find((r) => r.id === '2026-10-13-S1-pre');
  assert.equal(pre.at.getTime(), new Date(2026, 9, 13, 12, 5).getTime()); // 13:30 − 25 − 60
  assert.equal(pre.title, 'Sal a las 13:05 hacia F51 (25 min de viaje)');
  assert.match(pre.body, /empieza a las 13:30/);
  assert.equal(pre.travelMin, 25);
  const eve = rems.find((r) => r.id === '2026-10-13-S1-eve');
  assert.equal(eve.at.getTime(), new Date(2026, 9, 12, 20, 0).getTime()); // la víspera no cambia
  assert.match(eve.body, /Sal a las 13:05/);
  // Sin viaje: como siempre
  const f1 = rems.find((r) => r.id === '2026-10-14-F1-pre');
  assert.equal(f1.at.getTime(), new Date(2026, 9, 14, 5, 0).getTime());
  assert.match(f1.title, /Tu turno empieza en 1 h/);
  // Viaje de más de una hora
  const far = upsertCode(s, { code: 'F51', travelMin: 90 });
  assert.equal(travelText(dayTimedItems(far, '2026-10-13')[0]), 'Sal a las 12:00 hacia F51 (1 h 30 de viaje)');
});

test('viaje: solo el primer turno o evento con hora del día', () => {
  let s = upsertCode(travelState(), { code: 'TS', start: '10:00', end: '11:00' });
  s = setDay(s, '2026-10-13', ['S1', 'TS', 'F51']);
  const items = dayTimedItems(s, '2026-10-13');
  const by = Object.fromEntries(items.map((i) => [i.code, i]));
  assert.equal(by.TS.travelMin, 25);
  assert.equal(by.S1.travelMin, 0);
  assert.equal(by.S1.leaveAt, null);
});

test('ICS: la alarma «antes» se adelanta con el viaje; sin lugares publicados no dice adónde', () => {
  const s = travelState();
  const ics = buildICS(s, { now: NOW });
  const ev = vevent(ics, '2026-10-13-S1@turnos-mauricio');
  assert.deepEqual(alarms(ev), [
    { trigger: '-PT17H30M', text: 'Mañana: S1 Tarde a las 13:30 (sal a las 13:05)' },
    { trigger: '-PT1H25M', text: 'Sal a las 13:05 hacia F51 (25 min de viaje) · S1 Tarde a las 13:30' },
  ]);
  assert.match(prop(ev, 'DESCRIPTION'), /Viaje: sal a las 13:05 hacia F51 \(25 min de viaje\)/);
  // Calendario público sin lugares: ni F51 ni la dirección
  const priv = buildICS(s, { now: NOW, places: false });
  const pev = vevent(priv, '2026-10-13-S1@turnos-mauricio');
  assert.equal(alarms(pev)[1].text, 'Sal a las 13:05 (25 min de viaje) · S1 Tarde a las 13:30');
  assert.ok(!pev.join('\n').includes('F51'));
  assert.ok(!priv.includes('Karl-Marx'));
  // Sin viaje: igual que antes
  assert.deepEqual(alarms(vevent(ics, '2026-10-14-F1@turnos-mauricio')).map((a) => a.trigger), ['-PT10H', '-PT1H']);
  // Cambiar el viaje sube la SEQUENCE de ese día
  const seq = (x) => Number(prop(vevent(buildICS(x, { now: NOW }), '2026-10-13-S1@turnos-mauricio'), 'SEQUENCE').slice(9));
  assert.ok(seq(upsertCode(s, { code: 'F51', travelMin: 30 }, { now: new Date(NOW.getTime() + DAY) })) > seq(s));
});

test('ntfy: el aviso «antes» sale a la hora con viaje y con «Sal a las …»', async () => {
  const s = updateSettings(travelState(), { ntfy: { enabled: true, topic: 'turnos-mauricio-k3v9q2m7x1pd' } });
  const f = mockFetch(() => ({ status: 200, body: {} }));
  const r = await syncNtfy(s, NOW, f, { appUrl: undefined });
  const pre = f.calls.map((c) => c.json()).find((p) => p.sequence_id === '2026-10-13-S1-pre');
  assert.equal(pre.title, 'Sal a las 13:05 hacia F51 (25 min de viaje)');
  assert.equal(pre.delay, String(new Date(2026, 9, 13, 12, 5).getTime() / 1000));
  assert.deepEqual(r.errors, []);
});

test('mapsUrl: Apple Maps en iOS, Google Maps en el resto', () => {
  assert.equal(mapsUrl('Karl-Marx-Str. 1, Berlin', 'ios'), 'https://maps.apple.com/?q=Karl-Marx-Str.%201%2C%20Berlin');
  assert.equal(mapsUrl('Karl-Marx-Str. 1, Berlin', 'android'), 'https://www.google.com/maps/search/?api=1&query=Karl-Marx-Str.%201%2C%20Berlin');
  assert.equal(mapsUrl({ code: 'F51', place: 'Hermannstr. 5' }, 'desktop'), 'https://www.google.com/maps/search/?api=1&query=Hermannstr.%205');
  assert.equal(mapsUrl({ code: 'F51', place: '' }, 'ios'), null);
  assert.equal(mapsUrl('   ', 'ios'), null);
  assert.equal(mapsUrl(null), null);
});

// ---------- «Sube el plan» (§13.1) ----------

const OCT = { '2026-10-12': ['F1'], '2026-10-13': ['S1'] };
const PLAN_UID = 'plan-2026-11@turnos-mauricio';

test('«Sube el plan»: el 20 a las 19:00 si noviembre está vacío, 15 min, alarma al inicio', () => {
  const s = stateWith(OCT);
  const p = planUploadReminder(s, NOW);
  assert.deepEqual([p.id, p.key, p.year, p.month, p.moved, p.title], ['plan-2026-11', '2026-10-20', 2026, 11, false, '📷 Sube el plan de noviembre']);
  assert.equal(p.start.getTime(), new Date(2026, 9, 20, 19, 0).getTime());
  assert.equal(p.end - p.start, 15 * 60000);
  const ev = vevent(buildICS(s, { now: NOW }), PLAN_UID);
  assert.equal(prop(ev, 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261020T190000');
  assert.equal(prop(ev, 'DTEND'), 'DTEND;TZID=Europe/Berlin:20261020T191500');
  assert.equal(prop(ev, 'SUMMARY'), 'SUMMARY:📷 Sube el plan de noviembre');
  assert.equal(prop(ev, 'TRANSP'), 'TRANSP:TRANSPARENT');
  assert.deepEqual(alarms(ev).map((a) => a.trigger), ['-PT0M']);
  // Contenido estable del 1 al 20 (hasta las 19:00)
  assert.equal(buildICS(s, { now: new Date(2026, 9, 1, 0, 5) }), buildICS(s, { now: new Date(2026, 9, 20, 18, 59) }));
  // No cuenta como turno (para no proteger un calendario «vacío»)
  assert.equal(icsEventCount(buildICS(s, { now: NOW })), 2);
  assert.equal(icsEventCount(buildICS(stateWith({}), { now: NOW })), 0);
});

test('«Sube el plan»: pasado el 20, hoy a las 19:00 si aún no llegó; si no, mañana (SEQUENCE sube); el último día también', () => {
  const s = stateWith(OCT);
  const ev = (now) => vevent(buildICS(s, { now }), PLAN_UID);
  const seq = (now) => Number(prop(ev(now), 'SEQUENCE').slice(9));
  const dtstamp = (now) => prop(ev(now), 'DTSTAMP').slice(8);
  const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  // El 20 a las 19:30 ya pasó: mañana
  const at20 = new Date(2026, 9, 20, 19, 30);
  const p = planUploadReminder(s, at20);
  assert.deepEqual([p.key, p.moved], ['2026-10-21', true]);
  assert.equal(prop(ev(at20), 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261021T190000');
  assert.ok(seq(at20) > seq(NOW));
  // El 21 por la mañana (la app se abre y sincroniza): el aviso de HOY a las 19:00, el mismo de anoche
  const morning21 = new Date(2026, 9, 21, 10, 0);
  assert.deepEqual([planUploadReminder(s, morning21).key, planUploadReminder(s, morning21).moved], ['2026-10-21', true]);
  assert.equal(buildICS(s, { now: morning21 }), buildICS(s, { now: at20 }), 'no se mueve antes de sonar');
  // Cada mañana del 21 al 31: suena ese mismo día, antes de la siguiente apertura
  for (let d = 21; d <= 31; d++) {
    const open = new Date(2026, 9, d, 10, 0);
    const r = planUploadReminder(s, open);
    assert.equal(r.key, `2026-10-${d}`, `día ${d}`);
    assert.ok(r.start > open && r.start < new Date(2026, 9, d + 1, 10, 0));
    assert.ok(dtstamp(open) <= utc(open), 'el sello nunca es futuro');
  }
  // Pasadas las 19:00 del 21: mañana, con SEQUENCE mayor
  const evening21 = new Date(2026, 9, 21, 19, 30);
  assert.equal(planUploadReminder(s, evening21).key, '2026-10-22');
  assert.ok(seq(evening21) > seq(morning21));
  assert.equal(buildICS(s, { now: evening21 }), buildICS(s, { now: new Date(2026, 9, 22, 8, 0) }));
  // El último día a las 19:30: ya no queda mes
  assert.equal(planUploadReminder(s, new Date(2026, 9, 31, 19, 30)), null);
  assert.equal(ev(new Date(2026, 9, 31, 19, 30)), undefined);
});

test('«Sube el plan»: desaparece al cargar el mes; desactivable; diciembre → enero', () => {
  let s = stateWith(OCT);
  assert.ok(vevent(buildICS(s, { now: NOW }), PLAN_UID));
  s = setDay(s, '2026-11-30', ['F1']);
  assert.equal(planUploadReminder(s, NOW), null);
  assert.equal(vevent(buildICS(s, { now: NOW }), PLAN_UID), undefined);
  // Desactivado: nada; el cambio de avisos sella el calendario
  const off = updateSettings(stateWith(OCT), { reminders: { planUpload: false } }, { now: NOW });
  assert.equal(off.settings.reminders.planUpload, false);
  assert.equal(off.settings.calendarUpdatedAt, NOW.toISOString());
  assert.equal(planUploadReminder(off, NOW), null);
  assert.ok(!buildICS(off, { now: NOW }).includes('UID:plan-'));
  // Diciembre: el plan que falta es el de enero del año siguiente
  const dec = planUploadReminder(stateWith({ '2026-12-01': ['F1'] }), new Date(2026, 11, 5, 9, 0));
  assert.deepEqual([dec.id, dec.key, dec.title], ['plan-2027-01', '2026-12-20', '📷 Sube el plan de enero']);
  // Un «to» explícito anterior lo deja fuera
  assert.ok(!buildICS(stateWith(OCT), { now: NOW, to: '2026-10-15' }).includes('UID:plan-'));
  // Las tombstones no cuentan como plan cargado
  assert.ok(planUploadReminder({ ...stateWith(OCT), tombstones: { '2026-11-02': NOW.toISOString() } }, NOW));
});

// ---------- Nombre del calendario y UID por persona (§11) ----------

test('ICS: «Turnos de <nombre>» (solo el nombre de pila) o «Mis turnos»; UID propio en otra carpeta', () => {
  assert.equal(calendarName(createDefaultState()), 'Mis turnos');
  const ana = updateSettings(stateWith(OCT), { name: 'Ana María' });
  assert.equal(calendarName(ana), 'Turnos de Ana');
  assert.match(buildICS(ana, { now: NOW }), /\r\nX-WR-CALNAME:Turnos de Ana\r\n/);
  assert.match(buildICS(ana, { now: NOW }), /\r\nPRODID:-\/\/Turnos\/\/ES\r\n/);
  // Carpeta 'ana': otro dominio de UID (si alguien suscribe los dos calendarios no chocan)
  const inDir = updateSettings(ana, { sync: { dir: 'ana' } });
  assert.equal(uidDomain(inDir), 'turnos-dir-ana');
  const ics = buildICS(inDir, { now: NOW });
  assert.ok(vevent(ics, '2026-10-12-F1@turnos-dir-ana'));
  assert.ok(vevent(ics, 'plan-2026-11@turnos-dir-ana'));
  assert.ok(!ics.includes('@turnos-mauricio'));
  // La raíz (Mauricio) no cambia, y una carpeta llamada «mauricio» no usa su dominio
  assert.equal(uidDomain(stateWith(OCT)), 'turnos-mauricio');
  const mauDir = updateSettings(stateWith(OCT), { sync: { dir: 'mauricio' } });
  assert.equal(uidDomain(mauDir), 'turnos-dir-mauricio');
  assert.ok(!buildICS(mauDir, { now: NOW }).includes('@turnos-mauricio'));
  assert.equal(uidDomain(updateSettings(stateWith(OCT), { sync: { dir: 'Mal/dir' } })), 'turnos-mauricio');
});
