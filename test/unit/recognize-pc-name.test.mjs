// Nombre del empleado en la tabla del PC (SPEC §11): docs/js/recognize/pc/calendar.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normName, nameTokens, matchName, nameLabel, DEFAULT_EMPLOYEE, OTHER_SHEET_WARNING, otherSheetWarning, checkSingleRow, chooseRow } from '../../docs/js/recognize/pc/calendar.js';

// Palabras que da el OCR de la columna del nombre (el nombre va en dos líneas y debajo el puesto)
const MAURICIO = ['Ducuara', 'Mauricio', 'Pflegekraft'];
const ANA = ['Ducuara', 'Ana', 'Pflegekraft'];
const OTRA = ['Müller', 'Anna', 'Pflegehelfer'];
const ok = (words, name) => matchName(words, nameTokens(name)).ok;

test('normName: sin acentos, sin signos, minúsculas', () => {
  assert.equal(normName('Pérez-Müller'), 'perezmuller');
  assert.equal(normName('Straße'), 'strasse');
  assert.equal(normName('José Ñúñez'), 'josenunez');
  assert.equal(normName('Łukasz Øster'), 'lukaszoster');
  assert.equal(normName(null), '');
});

test('nameTokens: palabras de 3 letras o más', () => {
  assert.deepEqual(nameTokens('Ducuara Ana'), ['ducuara', 'ana']);
  assert.deepEqual(nameTokens('  Ducuara   Mauricio '), ['ducuara', 'mauricio']);
  assert.deepEqual(nameTokens('de la Cruz Li'), ['cruz']);
  assert.deepEqual(nameTokens('García-López, Ana'), ['garcialopez', 'ana']);
  assert.deepEqual(nameTokens(''), []);
  assert.deepEqual(nameTokens(undefined), []);
  assert.equal(DEFAULT_EMPLOYEE, 'Ducuara');
});

test('dos «Ducuara»: el nombre completo distingue las filas', () => {
  assert.equal(ok(MAURICIO, 'Ducuara Mauricio'), true);
  assert.equal(ok(ANA, 'Ducuara Mauricio'), false);
  assert.equal(ok(ANA, 'Ducuara Ana'), true);
  assert.equal(ok(MAURICIO, 'Ducuara Ana'), false);
  assert.equal(ok(OTRA, 'Ducuara Ana'), false);
  assert.deepEqual(matchName(MAURICIO, nameTokens('Ducuara Ana')).missing, ['ana']);
});

test('solo el apellido (compatibilidad): vale para las dos filas', () => {
  assert.equal(ok(MAURICIO, 'Ducuara'), true);
  assert.equal(ok(ANA, 'Ducuara'), true);
  assert.equal(ok(OTRA, 'Ducuara'), false);
});

test('el orden no importa y los acentos tampoco', () => {
  assert.equal(ok(MAURICIO, 'Mauricio Ducuara'), true);
  assert.equal(ok(['Ducuará', 'Maurício'], 'Ducuara Mauricio'), true);
  assert.equal(ok(['Muller', 'Anna'], 'Müller Anna'), true);
});

test('tolerancia de OCR: max(1, ⌊largo/4⌋) letras por palabra', () => {
  assert.equal(ok(['Ducuana', 'Mauriclo'], 'Ducuara Mauricio'), true); // 1 + 1
  assert.equal(ok(['Ducuara', 'Maurlcl0'], 'Ducuara Mauricio'), false); // 3 errores: «mauricio» admite 2
  assert.equal(ok(['Ducuara', 'Maurlclo'], 'Ducuara Mauricio'), true);
  assert.equal(ok(['Dacaana', 'Mauricio'], 'Ducuara Mauricio'), false); // 3 errores en «ducuara»
  assert.equal(ok(['Ducuara', 'Aria'], 'Ducuara Ana'), false);
  assert.equal(ok(['Ducuara', 'Ama'], 'Ducuara Ana'), false); // nombre corto (≤ 4 letras): sin tolerancia
  // palabras de menos de 3 letras no cuentan solas
  assert.equal(ok(['Ducuara', 'An'], 'Ducuara Ana'), false);
});

test('OCR que parte o pega palabras', () => {
  assert.equal(ok(['Ducuara', 'Mauri', 'cio'], 'Ducuara Mauricio'), true);
  assert.equal(ok(['DucuaraMauricio', 'Pflegekraft'], 'Ducuara Mauricio'), true);
  assert.equal(ok(['DucuaraAna'], 'Ducuara Ana'), true);
  assert.equal(ok(['DucuaraMauricio'], 'Ducuara Ana'), false);
  // una pareja que no es el nombre no da falsos positivos
  assert.equal(ok(['Ducuara', 'Mauricio', 'Pflegekraft'], 'Ducuara Pflegekraft Ana'), false);
});

test('acepta palabras como objetos del OCR ({ text })', () => {
  assert.equal(matchName([{ text: 'Ducuara' }, { text: 'Ana' }], nameTokens('Ducuara Ana')).ok, true);
  assert.equal(matchName([], nameTokens('Ducuara Ana')).ok, false);
  assert.equal(matchName(MAURICIO, []).ok, false); // sin palabras que buscar no hay coincidencia
});

test('nameLabel: espacios simples y largo limitado', () => {
  assert.equal(nameLabel('  Ducuara   Ana '), 'Ducuara Ana');
  assert.equal(nameLabel('x'.repeat(80)).length, 60);
});

test('nombres cortos (≤ 4 letras): «Juana», «Diana» o restos de OCR no valen por «Ana»', () => {
  for (const other of ['Juana', 'Diana', 'Mariana', 'Anna', 'Ania']) {
    assert.equal(ok(['Ducuara', other, 'Pflegekraft'], 'Ducuara Ana'), false, other);
    assert.equal(ok([`Ducuara${other}`], 'Ducuara Ana'), false, `pegado: ${other}`);
  }
  assert.equal(ok(['Ducuara', 'Juana'], 'Ducuara Juan'), false);
  // restos de OCR junto a la fila de Mauricio
  assert.equal(ok(['Ducuara', 'Mauricio', 'A', 'na'], 'Ducuara Ana'), false);
  assert.equal(ok(['Ducuara', 'Mauricio', 'Ana'], 'Ducuara Ana'), true); // la palabra entera sí
  // pegado: la parte corta exacta y con su largo
  assert.equal(ok(['DucuaraAna'], 'Ducuara Ana'), true);
  assert.equal(ok(['DucuanaAna'], 'Ducuara Ana'), true); // el apellido sí admite 1 error
  assert.equal(ok(['DucuaraAma'], 'Ducuara Ana'), false);
  assert.equal(ok(['AnaDucuara'], 'Ana Ducuara'), true);
  // los largos siguen con su tolerancia, también pegados
  assert.equal(ok(['DucuaraMaurlcio'], 'Ducuara Mauricio'), true);
  assert.equal(ok(['Ducuara', 'Mauriclo'], 'Ducuara Mauricio'), true);
  assert.equal(ok(['Ducuara', 'Ana'], 'Ducuara'), true);
});

test('aviso de hoja de otra persona: las palabras que faltan, como se escribieron', () => {
  assert.equal(otherSheetWarning('Ducuara Ana', ['ana']), 'Esta hoja parece de otra persona: no veo «Ana» en el nombre. Revisa antes de guardar.');
  assert.equal(otherSheetWarning('Pérez Ana María', ['ana', 'maria']), 'Esta hoja parece de otra persona: no veo «Ana» ni «María» en el nombre. Revisa antes de guardar.');
  assert.ok(otherSheetWarning('x', ['ducuara']).startsWith(OTHER_SHEET_WARNING));
});

// Lectura simulada de la columna del nombre de cada fila: { normal: palabras, flat: palabras }
const reader = (rows, tokens) => {
  const calls = [];
  const fn = async (i, flat) => { calls.push([i, flat]); return matchName((flat ? rows[i].flat : rows[i].normal) ?? rows[i].normal, tokens); };
  fn.calls = calls;
  return fn;
};

test('una sola fila: si se lee el apellido y falta el nombre de pila → nameMismatch', () => {
  const T = nameTokens('Ducuara Ana');
  const read = (w) => ({ ...matchName(w, T), legible: true });
  assert.deepEqual(checkSingleRow([read(MAURICIO), read(MAURICIO)], T), { ok: false, otherName: true, nameMismatch: ['ana'] });
  assert.deepEqual(checkSingleRow([read(ANA)], T), { ok: true, otherName: false, nameMismatch: null });
  // la 2.ª lectura encuentra el nombre: todo bien
  assert.deepEqual(checkSingleRow([read(['Ducuara', 'Ama']), read(ANA)], T), { ok: true, otherName: false, nameMismatch: null });
  // no se lee nada del nombre (OCR que no sirve u otra persona sin apellido común): solo el aviso suave
  assert.deepEqual(checkSingleRow([read(['Pflegekraft'])], T), { ok: false, otherName: true, nameMismatch: null });
  assert.deepEqual(checkSingleRow([{ ...matchName([], T), legible: false }], T), { ok: false, otherName: false, nameMismatch: null });
  // la lectura que más se acerca da lo que falta
  assert.deepEqual(checkSingleRow([read(['Pflegekraft']), read(['Ducuara'])], T).nameMismatch, ['ana']);
});

test('varias filas: solo el apellido → ninguna fila (pon tu nombre completo); con el nombre, la única que encaja', async () => {
  const rows = [{ normal: MAURICIO }, { normal: ['Dxcxxra', '4n4'] }]; // la fila de Ana, ilegible
  // Solo «Ducuara» (sin nombre de pila): antes se elegía la de Mauricio aunque la otra pudiera ser «Ducuara»
  const bare = reader(rows, nameTokens('Ducuara'));
  assert.deepEqual(await chooseRow(2, nameTokens('Ducuara'), bare), { index: -1, hits: 0, needFullName: true });
  assert.equal(bare.calls.length, 0, 'ni siquiera se lee');
  assert.deepEqual(await chooseRow(2, [], bare), { index: -1, hits: 0 });
  // Nombre completo: la fila de Mauricio, aunque la otra no se lea
  assert.deepEqual(await chooseRow(2, nameTokens('Ducuara Mauricio'), reader(rows, nameTokens('Ducuara Mauricio'))), { index: 0, hits: 1 });
  // Ana busca la suya y no se lee: ninguna (nunca la de su hermano)
  const ana = reader(rows, nameTokens('Ducuara Ana'));
  assert.deepEqual(await chooseRow(2, nameTokens('Ducuara Ana'), ana), { index: -1, hits: 0 });
  assert.deepEqual(ana.calls, [[0, false], [1, false], [0, true], [1, true]], '2.ª lectura de todas');
  // La 2.ª lectura la encuentra
  const better = [{ normal: MAURICIO }, { normal: ['Dxcxxra'], flat: ANA }];
  assert.deepEqual(await chooseRow(2, nameTokens('Ducuara Ana'), reader(better, nameTokens('Ducuara Ana'))), { index: 1, hits: 1 });
  // Restos de OCR («A», «na») junto a la fila de Mauricio no la convierten en la de Ana
  const junk = [{ normal: [...MAURICIO, 'A', 'na'] }, { normal: OTRA }];
  assert.deepEqual(await chooseRow(2, nameTokens('Ducuara Ana'), reader(junk, nameTokens('Ducuara Ana'))), { index: -1, hits: 0 });
  // Dos filas que encajan → ninguna
  const twice = [{ normal: ANA }, { normal: ANA }];
  assert.deepEqual(await chooseRow(2, nameTokens('Ducuara Ana'), reader(twice, nameTokens('Ducuara Ana'))), { index: -1, hits: 2 });
});
