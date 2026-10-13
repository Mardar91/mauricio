import { stateWith, memoryStorage, T0 } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, CORRUPT_PREFIX, createDefaultState, loadState, saveState, createStore, setDay, clearDay, applyScan,
  upsertCode, deleteCode, updateSettings, exportBackup, importBackup, migrateState, MAX_CHANGES,
} from '../../docs/js/core/store.js';
import { DEFAULT_CODES } from '../../docs/js/core/codes.js';

test('createDefaultState: forma del estado (§3)', () => {
  const s = createDefaultState();
  assert.equal(s.schema, 1);
  assert.deepEqual(Object.keys(s).sort(), ['changes', 'codeTombstones', 'codes', 'days', 'scans', 'schema', 'settings', 'tombstones']);
  assert.deepEqual(s.tombstones, {});
  assert.deepEqual(s.codeTombstones, {});
  assert.equal(s.settings.name, 'Mauricio');
  assert.equal(s.settings.weeklyHours, 35);
  assert.equal(s.settings.workDaysPerWeek, 5);
  assert.equal(s.settings.holidaysReduceSoll, true);
  assert.deepEqual(s.settings.reminders, { eveningBefore: true, eveningTime: '20:00', beforeStart: true, minutesBefore: 60 });
  assert.deepEqual(s.settings.sync, {
    enabled: false, owner: 'Mardar91', repo: 'mauricio-datos', branch: '', token: '', key: '', deviceId: '', baseRev: 0,
    lastPushAt: null, lastPushHash: null, lastIcsHash: null, lastPullAt: null, lastError: null, lastErrorCode: null,
    lastErrorDetail: null, lastErrorSince: null, publishPlaces: false, publisher: null, publisherSince: null, unpublished: 0,
    prevKey: '', lastSyncStartedAt: null,
  });
  assert.equal(s.settings.calendarUpdatedAt, null);
  assert.equal(s.settings.remindersUpdatedAt, null);
  assert.equal(s.settings.placesUpdatedAt, null);
  assert.deepEqual(s.settings.ntfy, { enabled: false, server: 'https://ntfy.sh', topic: '', scheduled: {}, lastRunAt: null, lastError: null });
  assert.equal(s.settings.onboardingDone, false);
  assert.deepEqual(Object.keys(s.codes).sort(), Object.keys(DEFAULT_CODES).sort());
  assert.ok(!Object.isFrozen(s.codes.F1));
  // Estados independientes
  const t = createDefaultState();
  s.settings.reminders.minutesBefore = 5;
  assert.equal(t.settings.reminders.minutesBefore, 60);
});

test('loadState: sin almacenamiento o vacío → estado por defecto', () => {
  assert.deepEqual(loadState(null), createDefaultState());
  assert.deepEqual(loadState(memoryStorage()), createDefaultState());
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('x'); } };
  assert.deepEqual(loadState(throwing), createDefaultState());
});

test('loadState: rellena campos que faltan y conserva lo del usuario', () => {
  const old = {
    schema: 1,
    settings: { name: 'Mauri', reminders: { minutesBefore: 30 }, sync: { token: 'abc', enabled: true } },
    codes: { F6: { code: 'F6', start: '07:00', end: '15:00', confirmed: true }, X1: { kind: 'shift', start: '08:00', end: '12:00' } },
    days: { '2026-10-12': { codes: ['F52', 'F1'] }, 'basura': { codes: ['F1'] }, '2026-10-13': { codes: 'S1' }, '2026-10-14': ['-'] },
  };
  const s = loadState(memoryStorage({ [STORAGE_KEY]: JSON.stringify(old) }));
  assert.equal(s.settings.name, 'Mauri');
  assert.equal(s.settings.reminders.minutesBefore, 30);
  assert.equal(s.settings.reminders.eveningTime, '20:00');
  assert.equal(s.settings.sync.token, 'abc');
  assert.equal(s.settings.sync.branch, '');
  assert.equal(s.settings.sync.repo, 'mauricio-datos');
  assert.deepEqual(s.settings.ntfy.scheduled, {});
  assert.equal(s.codes.F6.start, '07:00');
  assert.equal(s.codes.F6.confirmed, true);
  assert.equal(s.codes.F6.breakMin, 30); // campo que faltaba
  assert.equal(s.codes.X1.kind, 'shift');
  assert.equal(s.codes.X1.builtin, false);
  assert.equal(s.codes.N1.start, '22:00'); // código de fábrica rellenado
  assert.deepEqual(s.days['2026-10-12'].codes, ['F1', 'F52']);
  assert.deepEqual(s.days['2026-10-14'].codes, ['-']);
  assert.equal(s.days.basura, undefined);
  assert.equal(s.days['2026-10-13'], undefined);
  assert.deepEqual(s.scans, []);
  assert.deepEqual(s.changes, []);
});

test('loadState: JSON corrupto → copia de seguridad y estado nuevo, sin lanzar', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{"schema":1, "days": {' });
  const s = loadState(storage);
  assert.deepEqual(s, createDefaultState());
  const copies = [...storage.map.keys()].filter((k) => k.startsWith(CORRUPT_PREFIX));
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^turnos-mauricio:corrupt:\d+$/);
  assert.equal(storage.getItem(copies[0]), '{"schema":1, "days": {');
  // JSON válido pero no es un objeto
  const storage2 = memoryStorage({ [STORAGE_KEY]: '[1,2,3]' });
  assert.deepEqual(loadState(storage2), createDefaultState());
  assert.equal([...storage2.map.keys()].filter((k) => k.startsWith(CORRUPT_PREFIX)).length, 1);
});

test('saveState / loadState ida y vuelta', () => {
  const storage = memoryStorage();
  const s = stateWith({ '2026-10-12': ['F1', 'F52'] });
  assert.equal(saveState(s, storage), true);
  assert.deepEqual(loadState(storage), s);
  assert.equal(saveState(s, null), false);
  assert.equal(saveState(s, { setItem() { throw new Error('QuotaExceeded'); } }), false);
});

test('createStore: borrador, estado devuelto, suscripción y guardado automático', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s));
  const before = store.get();
  store.set((d) => { d.settings.name = 'Mauricio D.'; });
  assert.equal(store.get().settings.name, 'Mauricio D.');
  assert.equal(before.settings.name, 'Mauricio'); // el anterior no se toca
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).settings.name, 'Mauricio D.');
  store.set((s) => setDay(s, '2026-10-12', ['F1']));
  assert.deepEqual(store.get().days['2026-10-12'].codes, ['F1']);
  assert.equal(seen.length, 2);
  unsubscribe();
  store.set((d) => { d.settings.onboardingDone = true; });
  assert.equal(seen.length, 2);
  assert.equal(createStore(storage).get().settings.onboardingDone, true);
});

test('setDay: normaliza, registra el cambio y es puro', () => {
  const s0 = createDefaultState();
  const s1 = setDay(s0, '2026-10-12', ['F52', 'f1'], { now: T0, source: 'manual', note: 'llevar llaves' });
  assert.equal(s0.days['2026-10-12'], undefined);
  assert.deepEqual(s1.days['2026-10-12'], { codes: ['F1', 'F52'], note: 'llevar llaves', source: 'manual', updatedAt: T0.toISOString() });
  assert.deepEqual(s1.changes, [{ at: T0.toISOString(), dayKey: '2026-10-12', before: [], after: ['F1', 'F52'], source: 'manual' }]);
  const s2 = setDay(s1, '2026-10-12', ['S1', 'S51'], { source: 'scan', now: T0 });
  assert.equal(s2.days['2026-10-12'].note, 'llevar llaves'); // la nota se conserva
  assert.equal(s2.days['2026-10-12'].source, 'scan');
  assert.deepEqual(s2.changes[1].before, ['F1', 'F52']);
  assert.deepEqual(s2.changes[1].after, ['S1', 'S51']);
  // Sin cambios → mismo objeto
  assert.equal(setDay(s2, '2026-10-12', ['S51', 'S1']), s2);
  // Solo cambia la nota → sin registro
  const s3 = setDay(s2, '2026-10-12', ['S1', 'S51'], { note: '' });
  assert.equal(s3.days['2026-10-12'].note, '');
  assert.equal(s3.changes.length, 2);
  // Plan cargado pero vacío
  const s4 = setDay(s3, '2026-10-13', []);
  assert.deepEqual(s4.days['2026-10-13'].codes, []);
  assert.throws(() => setDay(s4, '13/10/2026', ['F1']), /Fecha no válida/);
});

test('setDay crea códigos desconocidos por analogía', () => {
  const s = setDay(createDefaultState(), '2026-11-02', ['F4', 'F54']);
  assert.equal(s.codes.F4.kind, 'shift');
  assert.equal(s.codes.F4.start, '06:00');
  assert.equal(s.codes.F4.confirmed, false);
  assert.equal(s.codes.F4.builtin, false);
  assert.equal(s.codes.F54.kind, 'place');
});

test('clearDay y límite de 300 cambios', () => {
  let s = stateWith({ '2026-10-12': ['F1'] });
  s = clearDay(s, '2026-10-12', { now: T0 });
  assert.equal(s.days['2026-10-12'], undefined);
  assert.deepEqual(s.changes.at(-1), { at: T0.toISOString(), dayKey: '2026-10-12', before: ['F1'], after: [], source: 'manual' });
  assert.equal(clearDay(s, '2026-10-12'), s);
  for (let i = 0; i < MAX_CHANGES + 20; i++) s = setDay(s, '2026-10-20', [i % 2 ? 'F1' : 'S1']);
  assert.equal(s.changes.length, MAX_CHANGES);
});

test('applyScan: guarda los días aceptados y registra el escaneo', () => {
  const s0 = stateWith({ '2026-10-12': ['F1', 'F52'], '2026-10-13': ['Z1'] });
  const scan = {
    layout: 'phone-list', month: 10, year: 2026, warnings: [],
    days: [
      { day: 12, codes: ['F1', 'F52'], confidence: 0.95 },
      { day: 13, codes: ['S1', 'S51'], confidence: 0.9 },
      { day: 14, codes: ['-'], confidence: 0.9 },
      { day: 15, codes: ['S1', 'S31'], confidence: 0.4 },
    ],
  };
  const s1 = applyScan(s0, scan, { acceptedKeys: ['2026-10-13', '2026-10-14'], now: T0 });
  assert.deepEqual(s1.days['2026-10-13'].codes, ['S1', 'S51']);
  assert.equal(s1.days['2026-10-13'].source, 'scan');
  assert.deepEqual(s1.days['2026-10-14'].codes, ['-']);
  assert.equal(s1.days['2026-10-15'], undefined);
  assert.deepEqual(s1.scans, [{ at: T0.toISOString(), layout: 'phone-list', month: 10, year: 2026, daysFound: 4 }]);
  assert.deepEqual(s1.changes.filter((c) => c.source === 'scan').map((c) => c.dayKey), ['2026-10-13', '2026-10-14']);
  assert.equal(s0.scans.length, 0);
  // Sin acceptedKeys → todos
  const s2 = applyScan(s0, scan);
  assert.deepEqual(Object.keys(s2.days).sort(), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
  // Mes corregido a mano en la revisión
  const s3 = applyScan(createDefaultState(), { ...scan, month: null, year: null }, { year: 2026, month: 11 });
  assert.deepEqual(s3.days['2026-11-13'].codes, ['S1', 'S51']);
  assert.equal(s3.scans[0].month, 11);
});

test('upsertCode y deleteCode', () => {
  let s = createDefaultState();
  s = upsertCode(s, { code: 'f6', start: '7:00', end: '15:30', confirmed: true });
  assert.equal(s.codes.F6.start, '07:00');
  assert.equal(s.codes.F6.end, '15:30');
  assert.equal(s.codes.F6.name, 'Mañana');
  assert.equal(s.codes.F6.builtin, true);
  s = upsertCode(s, { code: 'K', kind: 'sick', name: 'Enfermo', color: '#888888' });
  assert.equal(s.codes.K.kind, 'sick');
  assert.equal(s.codes.K.builtin, false);
  assert.throws(() => upsertCode(s, { code: '' }), /vacío/);
  assert.throws(() => upsertCode(s, { code: 'F7', start: '25:00' }), /no válida/);
  s = deleteCode(s, 'K');
  assert.equal(s.codes.K, undefined);
  s = deleteCode(s, 'F6'); // de fábrica → vuelve al original
  assert.equal(s.codes.F6.start, '06:00');
  assert.equal(s.codes.F6.confirmed, false);
});

test('updateSettings: mezcla profunda; el mapa de ntfy se reemplaza entero', () => {
  let s = createDefaultState();
  s = updateSettings(s, { reminders: { minutesBefore: 30 }, sync: { token: 'tok' } });
  assert.deepEqual(s.settings.reminders, { eveningBefore: true, eveningTime: '20:00', beforeStart: true, minutesBefore: 30 });
  assert.equal(s.settings.sync.token, 'tok');
  assert.equal(s.settings.sync.owner, 'Mardar91');
  s = updateSettings(s, { ntfy: { scheduled: { a: { at: 'x', hash: '1' }, b: { at: 'y', hash: '2' } } } });
  s = updateSettings(s, { ntfy: { scheduled: { b: { at: 'y', hash: '2' } } } });
  assert.deepEqual(Object.keys(s.settings.ntfy.scheduled), ['b']);
  assert.equal(s.settings.ntfy.server, 'https://ntfy.sh');
  const t = updateSettings(s, { name: 'M' });
  assert.equal(s.settings.name, 'Mauricio');
  assert.equal(t.settings.name, 'M');
});

test('exportBackup no incluye token, clave ni ajustes del dispositivo; importBackup restaura', () => {
  let s = stateWith({ '2026-10-12': ['F1', 'F52'], '2026-10-13': ['S1'] });
  s = updateSettings(s, { name: 'Mauri', sync: { enabled: true, token: 'github_pat_SECRETO123', key: 'K'.repeat(43), lastPushHash: 'h' }, ntfy: { topic: 'turnos-mauricio-abc' } });
  const json = exportBackup(s, { now: T0 });
  assert.ok(!json.includes('github_pat_SECRETO123'));
  assert.ok(!json.includes('K'.repeat(43)));
  assert.ok(!json.includes('turnos-mauricio-abc'));
  const data = JSON.parse(json);
  assert.equal(data.app, 'turnos-mauricio');
  assert.equal(data.exportedAt, T0.toISOString());
  assert.equal(data.settings.sync, undefined);
  assert.equal(data.settings.ntfy, undefined);
  assert.equal(data.settings.name, 'Mauri');
  assert.deepEqual(data.tombstones, {});

  // Teléfono ya conectado (sync activa y ya leyó): lo importado pasa a ser lo más nuevo
  let phone = updateSettings(createDefaultState(), { sync: { token: 'OTRO_TOKEN', enabled: true, lastPullAt: T0.toISOString() } });
  phone = setDay(phone, '2026-10-20', ['N1'], { now: T0 });
  const NOW = new Date('2026-10-14T10:00:00Z');
  const restored = importBackup(phone, json, { now: NOW });
  assert.deepEqual(restored.days['2026-10-12'].codes, ['F1', 'F52']);
  assert.equal(restored.days['2026-10-12'].updatedAt, NOW.toISOString()); // lo importado es lo más nuevo
  assert.equal(restored.days['2026-10-12'].source, 'import');
  assert.equal(restored.days['2026-10-20'], undefined);
  assert.equal(restored.tombstones['2026-10-20'], NOW.toISOString()); // el borrado llegará a otros dispositivos
  assert.equal(restored.settings.name, 'Mauri');
  assert.equal(restored.settings.sync.token, 'OTRO_TOKEN');
  assert.equal(restored.settings.sync.enabled, true); // la sync de este teléfono no cambia
  assert.equal(restored.settings.sync.lastPullAt, T0.toISOString());
  assert.ok(restored.changes.some((c) => c.source === 'import' && c.dayKey === '2026-10-20'));
});

test('importBackup valida y da errores en español', () => {
  const s = createDefaultState();
  assert.throws(() => importBackup(s, 'no es json'), /no es una copia de seguridad válida/);
  assert.throws(() => importBackup(s, '[]'), /no es una copia de seguridad válida/);
  assert.throws(() => importBackup(s, JSON.stringify({ app: 'otra', days: {} })), /no es una copia de Turnos/);
  assert.throws(() => importBackup(s, JSON.stringify({ settings: {} })), /no contiene días/);
  assert.throws(() => importBackup(s, JSON.stringify({ days: { '2026-13-01': { codes: [] } } })), /fecha no válida/);
  assert.throws(() => importBackup(s, JSON.stringify({ days: { '2026-10-01': { codes: [1] } } })), /no válidos/);
  assert.throws(() => importBackup(s, JSON.stringify({ schema: 9, days: {} })), /más nueva/);
  const ok = importBackup(s, JSON.stringify({ days: { '2026-10-01': { codes: ['F1'] } } }));
  assert.deepEqual(ok.days['2026-10-01'].codes, ['F1']);
});

test('updateSettings ignora valores de tipo incorrecto', () => {
  const s = updateSettings(createDefaultState(), { sync: 'x', reminders: { minutesBefore: '30', eveningBefore: false }, ntfy: { scheduled: [] }, name: 5 });
  assert.equal(s.settings.sync.owner, 'Mardar91');
  assert.equal(s.settings.reminders.minutesBefore, 60);
  assert.equal(s.settings.reminders.eveningBefore, false);
  assert.deepEqual(s.settings.ntfy.scheduled, {});
  assert.equal(s.settings.name, 'Mauricio');
  assert.equal(updateSettings(s, { sync: { lastPushAt: '2026-10-12T10:00:00.000Z' } }).settings.sync.lastPushAt, '2026-10-12T10:00:00.000Z');
});

test('upsertCode: guardar un horario lo confirma; los días cargados tienen siempre su código', () => {
  const s = upsertCode(createDefaultState(), { code: 'F8', start: '06:30', end: '14:00' });
  assert.equal(s.codes.F8.confirmed, true);
  assert.equal(upsertCode(createDefaultState(), { code: 'F8', end: '14:00', confirmed: false }).codes.F8.confirmed, false);
  assert.equal(upsertCode(createDefaultState(), { code: 'F8', color: '#FFFF00' }).codes.F8.confirmed, false);
  const loaded = migrateState({ days: { '2026-10-12': { codes: ['F4', 'X12'] } } });
  assert.equal(loaded.codes.F4.kind, 'shift');
  assert.equal(loaded.codes.F4.confirmed, false);
  assert.equal(loaded.codes.X12.kind, 'place');
});

test('migrateState nunca lanza con datos raros', () => {
  for (const raw of [null, 42, 'x', [], { settings: 'x', codes: [], days: 5, scans: {}, changes: 'y' },
    { settings: { weeklyHours: 'abc', workDaysPerWeek: 0, ntfy: { scheduled: [] } } }]) {
    const s = migrateState(raw);
    assert.equal(s.schema, 1);
    assert.equal(s.settings.weeklyHours > 0, true);
    assert.equal(s.settings.workDaysPerWeek >= 1, true);
    assert.equal(typeof s.settings.ntfy.scheduled, 'object');
  }
});
