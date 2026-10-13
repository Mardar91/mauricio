import { stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanToDays, diffScan, mergeScans } from '../../docs/js/core/diff.js';

test('scanToDays: día → clave, limpia códigos, descarta días imposibles', () => {
  const r = {
    layout: 'phone-list', month: 6, year: 2026, warnings: [],
    days: [
      { day: 2, codes: ['-'], confidence: 0.9 },
      { day: 1, codes: ['f6', 'F52', 'F6'], confidence: 0.8 },
      { day: 31, codes: ['F1'], confidence: 0.9 }, // junio no tiene 31
      { day: 0, codes: ['F1'] },
      { day: 3, codes: ['w–'] },
      { day: 2, codes: ['S1'], confidence: 0.5 }, // repetido con menos confianza
    ],
  };
  assert.deepEqual(scanToDays(r), [
    { key: '2026-06-01', codes: ['F6', 'F52'], confidence: 0.8 },
    { key: '2026-06-02', codes: ['-'], confidence: 0.9 },
    { key: '2026-06-03', codes: ['W-'], confidence: 1 },
  ]);
  assert.deepEqual(scanToDays({ ...r, month: null }), []);
  assert.equal(scanToDays({ ...r, month: null }, { year: 2026, month: 7 })[0].key, '2026-07-01');
  assert.deepEqual(scanToDays({ days: [{ key: '2026-10-12', codes: ['F1'] }] }), [{ key: '2026-10-12', codes: ['F1'], confidence: 1 }]);
  assert.deepEqual(scanToDays(null), []);
});

test('diffScan: new / changed / same', () => {
  const s = stateWith({ '2026-10-12': ['F1', 'F52'], '2026-10-13': ['Z1'], '2026-10-14': [] });
  const d = diffScan(s, [
    { key: '2026-10-12', codes: ['F52', 'F1'], confidence: 0.9 },
    { key: '2026-10-13', codes: ['S1', 'S51'], confidence: 0.8 },
    { key: '2026-10-14', codes: [] },
    { key: '2026-10-15', codes: ['S31', 'S1'], confidence: 0.4 },
  ]);
  assert.deepEqual(d.map((x) => x.type), ['same', 'changed', 'same', 'new']);
  assert.deepEqual(d[1], { key: '2026-10-13', before: ['Z1'], after: ['S1', 'S51'], type: 'changed', confidence: 0.8 });
  assert.deepEqual(d[3].before, null);
  assert.deepEqual(d[3].after, ['S1', 'S31']);
});

test('mergeScans: unión de varias fotos del mismo mes', () => {
  const a = { layout: 'phone-list', month: 10, year: 2026, warnings: ['a'], days: [
    { day: 10, codes: ['F1', 'F51'], confidence: 0.9 },
    { day: 11, codes: ['F1', 'F51'], confidence: 0.9 },
    { day: 21, codes: ['F1'], confidence: 0.5 },
  ] };
  const b = { layout: 'phone-list', month: 10, year: 2026, warnings: ['a', 'b'], days: [
    { day: 21, codes: ['F1'], confidence: 0.8 },
    { day: 22, codes: ['N1'], confidence: 0.95 },
  ] };
  const m = mergeScans([a, b]);
  assert.equal(m.layout, 'phone-list');
  assert.equal(m.month, 10);
  assert.equal(m.year, 2026);
  assert.deepEqual(m.warnings, ['a', 'b']);
  assert.deepEqual(m.days, [
    { day: 10, codes: ['F1', 'F51'], confidence: 0.9 },
    { day: 11, codes: ['F1', 'F51'], confidence: 0.9 },
    { day: 21, codes: ['F1'], confidence: 0.8 },
    { day: 22, codes: ['N1'], confidence: 0.95 },
  ]);
});

test('mergeScans: si dos fotos discrepan gana la de mayor confianza y se marca conflicto', () => {
  const a = { layout: 'phone-list', month: 10, year: 2026, days: [{ day: 13, codes: ['S1', 'S51'], confidence: 0.9 }] };
  const b = { layout: 'phone-list', month: 10, year: 2026, days: [{ day: 13, codes: ['Z1'], confidence: 0.6 }] };
  const m = mergeScans([b, a]);
  assert.equal(m.days.length, 1);
  assert.deepEqual(m.days[0].codes, ['S1', 'S51']);
  assert.equal(m.days[0].conflict, true);
  assert.deepEqual(m.days[0].alternatives, [['Z1']]);
  assert.ok(m.days[0].confidence < 0.9);
  // El conflicto llega a la revisión
  const days = scanToDays(m);
  assert.equal(days[0].conflict, true);
  assert.equal(diffScan(stateWith(), days)[0].conflict, true);
  // El orden de los códigos no es una discrepancia
  const c = { month: 10, year: 2026, days: [{ day: 13, codes: ['S51', 'S1'], confidence: 0.7 }] };
  assert.equal(mergeScans([a, c]).days[0].conflict, undefined);
});

test('mergeScans: fotos de otro mes se excluyen; sin mes se supone el mayoritario', () => {
  const oct1 = { layout: 'phone-list', month: 10, year: 2026, days: [{ day: 1, codes: ['F1'], confidence: 0.9 }] };
  const oct2 = { layout: 'phone-list', month: 10, year: 2026, days: [{ day: 2, codes: ['S1'], confidence: 0.9 }] };
  const sep = { layout: 'phone-list', month: 9, year: 2026, days: [{ day: 3, codes: ['N1'], confidence: 0.9 }] };
  const none = { layout: 'unknown', month: null, year: null, days: [{ day: 4, codes: ['-'], confidence: 0.7 }] };
  const m = mergeScans([oct1, sep, oct2, none]);
  assert.equal(m.month, 10);
  assert.deepEqual(m.days.map((d) => d.day), [1, 2, 4]);
  assert.deepEqual(m.excluded, [1]);
  assert.ok(m.warnings.some((w) => w.includes('septiembre 2026')));
  assert.ok(m.warnings.some((w) => w.includes('no se vio el mes')));
  assert.deepEqual(mergeScans([]), { layout: 'unknown', month: null, year: null, days: [], warnings: [] });
});
