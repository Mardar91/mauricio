import { stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CODES, guessCode, getCode, kindOf, shiftInterval, normalizeDayCodes, cleanCode, unknownCodes,
  isNightCode, codeEmoji, nominalMinutes,
} from '../../docs/js/core/codes.js';
import { upsertCode } from '../../docs/js/core/store.js';

const FIELDS = ['code', 'kind', 'name', 'start', 'end', 'breakMin', 'countsHours', 'creditHours', 'color',
  'textColor', 'shape', 'place', 'confirmed', 'builtin'];

test('DEFAULT_CODES tiene todos los códigos del plan con todos los campos', () => {
  const expected = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51',
    'S31', 'TS', 'W-', 'U', '-'];
  assert.deepEqual(Object.keys(DEFAULT_CODES).sort(), expected.sort());
  for (const def of Object.values(DEFAULT_CODES)) {
    assert.deepEqual(Object.keys(def).sort(), [...FIELDS].sort(), def.code);
    assert.equal(def.builtin, true);
  }
});

test('turnos por defecto (§2)', () => {
  const t = (c) => [DEFAULT_CODES[c].kind, DEFAULT_CODES[c].name, DEFAULT_CODES[c].start, DEFAULT_CODES[c].end,
    DEFAULT_CODES[c].breakMin, DEFAULT_CODES[c].countsHours, DEFAULT_CODES[c].confirmed];
  assert.deepEqual(t('F1'), ['shift', 'Mañana', '06:00', '15:00', 30, true, true]);
  assert.deepEqual(t('S1'), ['shift', 'Tarde', '13:30', '22:00', 30, true, true]);
  assert.deepEqual(t('N1'), ['shift', 'Noche', '22:00', '06:00', 30, true, true]);
  assert.deepEqual(t('Z1'), ['shift', 'Intermedio', '09:30', '18:00', 30, true, true]);
  for (const c of ['F2', 'F3', 'F6', 'F8']) assert.deepEqual(t(c), ['shift', 'Mañana', '06:00', '15:00', 30, true, false]);
  assert.equal(DEFAULT_CODES.F1.color, '#F2E500');
  assert.equal(DEFAULT_CODES.S1.color, '#8DC47E');
  assert.equal(DEFAULT_CODES.N1.color, '#3D63B8');
  assert.equal(DEFAULT_CODES.N1.textColor, '#FFFFFF');
  assert.equal(DEFAULT_CODES.Z1.color, '#F3B9BF');
  for (const c of ['F1', 'S1', 'N1', 'Z1']) assert.equal(DEFAULT_CODES[c].shape, 'circle');
});

test('lugares, reunión, libres y vacaciones (§2)', () => {
  for (const c of ['F51', 'F52', 'F53', 'S51', 'S52', 'N51']) {
    const d = DEFAULT_CODES[c];
    assert.equal(d.kind, 'place');
    assert.equal(d.name, `Lugar ${c}`);
    assert.equal(d.color, '#E31CE0');
    assert.equal(d.countsHours, false);
    assert.equal(d.start, null);
  }
  assert.equal(DEFAULT_CODES.S31.kind, 'place');
  assert.equal(DEFAULT_CODES.S31.color, '#E0281E');
  const ts = DEFAULT_CODES.TS;
  assert.deepEqual([ts.kind, ts.name, ts.shape, ts.start, ts.countsHours], ['event', 'Reunión de equipo', 'hexagon', null, false]);
  const w = DEFAULT_CODES['W-'];
  assert.deepEqual([w.kind, w.name, w.shape, w.color], ['wish', 'Libre deseado', 'tag', '#F4B6BF']);
  const u = DEFAULT_CODES.U;
  assert.deepEqual([u.kind, u.name, u.shape, u.creditHours, u.textColor], ['vacation', 'Vacaciones', 'text', null, '#D21F1F']);
  const off = DEFAULT_CODES['-'];
  assert.deepEqual([off.kind, off.name, off.shape, off.countsHours], ['off', 'Libre', 'text', false]);
});

test('DEFAULT_CODES no se puede modificar por accidente', () => {
  assert.ok(Object.isFrozen(DEFAULT_CODES));
  assert.ok(Object.isFrozen(DEFAULT_CODES.F1));
});

test('guessCode: códigos nuevos por analogía', () => {
  const f4 = guessCode('F4');
  assert.deepEqual([f4.code, f4.kind, f4.start, f4.end, f4.breakMin, f4.confirmed, f4.builtin], ['F4', 'shift', '06:00', '15:00', 30, false, false]);
  const s2 = guessCode('s2');
  assert.deepEqual([s2.code, s2.start, s2.end, s2.color], ['S2', '13:30', '22:00', '#8DC47E']);
  const n3 = guessCode('N3');
  assert.deepEqual([n3.start, n3.end], ['22:00', '06:00']);
  assert.equal(guessCode('Z2').start, '09:30');
  const f54 = guessCode('F54');
  assert.deepEqual([f54.kind, f54.name, f54.color, f54.countsHours], ['place', 'Lugar F54', '#E31CE0', false]);
  const k = guessCode('K');
  assert.equal(k.kind, 'other');
  assert.equal(k.countsHours, false);
  assert.equal(k.confirmed, false);
  assert.equal(guessCode('F1').confirmed, true); // conocido → definición por defecto
});

test('getCode / kindOf / unknownCodes', () => {
  let s = stateWith();
  assert.equal(getCode(s, 'F1').start, '06:00');
  assert.equal(kindOf(s, 'N51'), 'place');
  assert.equal(kindOf(s, 'F4'), 'shift');
  assert.equal(kindOf(s, 'w-'), 'wish');
  s = upsertCode(s, { code: 'F6', start: '07:00', end: '15:30', confirmed: true });
  assert.equal(getCode(s, 'F6').start, '07:00');
  assert.equal(getCode(s, 'F6').confirmed, true);
  assert.equal(getCode(null, 'S1').end, '22:00');
  assert.deepEqual(unknownCodes(s, ['F1', 'F4', 'X9', 'F4']), ['F4', 'X9']);
});

test('cleanCode unifica guiones y mayúsculas', () => {
  assert.equal(cleanCode(' w– '), 'W-');
  assert.equal(cleanCode('−'), '-');
  assert.equal(cleanCode('f 1'), 'F1');
});

test('shiftInterval: mismo día, noche y cambio de hora', () => {
  const s = stateWith();
  const f1 = shiftInterval(s, '2026-10-12', 'F1');
  assert.equal(f1.start.getHours(), 6);
  assert.equal(f1.end.getHours(), 15);
  assert.equal((f1.end - f1.start) / 3600000, 9);
  const n1 = shiftInterval(s, '2026-10-17', 'N1');
  assert.equal(n1.start.getDate(), 17);
  assert.equal(n1.end.getDate(), 18);
  assert.equal((n1.end - n1.start) / 3600000, 8);
  // Fin del horario de verano: 2026-10-25 03:00 → 02:00
  const dst = shiftInterval(s, '2026-10-24', 'N1');
  assert.equal((dst.end - dst.start) / 3600000, 9);
  assert.equal(dst.end.getHours(), 6);
  // Inicio del horario de verano: 2026-03-29 02:00 → 03:00
  const spring = shiftInterval(s, '2026-03-28', 'N1');
  assert.equal((spring.end - spring.start) / 3600000, 7);
  assert.equal(shiftInterval(s, '2026-10-12', 'F51'), null);
  assert.equal(shiftInterval(s, '2026-10-12', 'TS'), null);
  assert.equal(shiftInterval(s, '2026-10-12', 'U'), null);
});

test('isNightCode / nominalMinutes / codeEmoji', () => {
  assert.ok(isNightCode(DEFAULT_CODES.N1));
  assert.ok(!isNightCode(DEFAULT_CODES.F1));
  assert.equal(nominalMinutes(DEFAULT_CODES.N1), 480);
  assert.equal(nominalMinutes(DEFAULT_CODES.TS), null);
  assert.equal(codeEmoji(DEFAULT_CODES.F1), '🌅');
  assert.equal(codeEmoji(DEFAULT_CODES.Z1), '☀️');
  assert.equal(codeEmoji(DEFAULT_CODES.S1), '🌇');
  assert.equal(codeEmoji(DEFAULT_CODES.N1), '🌙');
  assert.equal(codeEmoji(DEFAULT_CODES.TS), '👥');
});

test('normalizeDayCodes: turnos, eventos, otros, lugares; sin duplicados', () => {
  const s = stateWith();
  assert.deepEqual(normalizeDayCodes(s, ['F52', 'F1']), ['F1', 'F52']);
  assert.deepEqual(normalizeDayCodes(s, ['N51', 'TS', 'F1', 'F1']), ['F1', 'TS', 'N51']);
  assert.deepEqual(normalizeDayCodes(s, ['S51', 'W-', 'TS', 'S1']), ['S1', 'TS', 'W-', 'S51']);
  assert.deepEqual(normalizeDayCodes(s, ['w–', '', null, ' u ']), ['W-', 'U']);
  assert.deepEqual(normalizeDayCodes(s, ['F54', 'F4']), ['F4', 'F54']);
  assert.deepEqual(normalizeDayCodes(s, []), []);
});
