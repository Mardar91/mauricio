// Reconocedor (docs/js/recognize/): funciones puras de index.js (fusión A + B, saneado, disparo de B, avisos)
// y el arranque del pool de Tesseract con un Tesseract falso (error al cargar el idioma, tiempo máximo,
// dispose() durante el arranque, lecturas de una época anterior).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePhone, sanitize, looksIncomplete, dedupeWarnings, codeKind, recognize, RULES, OCR_FAILED } from '../../docs/js/recognize/index.js';
import { ready, recognizeImage, disposePool, poolInfo, poolEpoch, setStartTimeout, startErrorFor, defaultPaths } from '../../docs/js/recognize/ocr-pool.js';

const KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];

// Resultado de un lector ya saneado: días como { día: [códigos] } o { día: [[códigos], confianza] }
function R(days = {}, extra = {}) {
  const list = Object.entries(days).map(([d, v]) => (Array.isArray(v[0]) ? { day: +d, codes: v[0], confidence: v[1] } : { day: +d, codes: v, confidence: 0.9 }));
  return { layout: 'phone-list', month: 10, year: 2026, days: list, warnings: [], ...extra };
}
const daysOf = (r) => Object.fromEntries(r.days.map((d) => [d.day, d.codes]));
const week = (from, to, code = 'F1') => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, [code]]));

// ---------- mergePhone ----------

test('mergePhone: solo A → sus días tal cual, sin avisos', () => {
  const r = mergePhone(R({ 1: ['F1'], 2: ['S1', 'F52'], 3: [] }), null, KNOWN);
  assert.deepEqual(daysOf(r), { 1: ['F1'], 2: ['S1', 'F52'], 3: [] });
  assert.equal(r.layout, 'phone-list');
  assert.equal(r.month, 10); assert.equal(r.year, 2026);
  assert.deepEqual(r.warnings, []);
});

test('mergePhone: unión de A y B; si coinciden, confianza = máximo', () => {
  const a = R({ 1: [['F1'], 0.6], 2: [['S1'], 0.9], 3: [['N1'], 0.7] });
  const b = R({ 2: [['S1'], 0.5], 3: [['N1'], 0.95], 4: [['-'], 0.8] });
  const r = mergePhone(a, b, KNOWN);
  assert.deepEqual(daysOf(r), { 1: ['F1'], 2: ['S1'], 3: ['N1'], 4: ['-'] });
  assert.deepEqual(r.days.map((d) => d.confidence), [0.6, 0.9, 0.95, 0.8]);
  assert.deepEqual(r.warnings, []);
});

test('mergePhone: un día en conflicto se omite (y se avisa); el resto se queda', () => {
  const a = R({ 1: ['F1'], 2: ['S1'], 3: ['N1'] });
  const b = R({ 1: ['F1'], 2: ['S51', 'S1'], 3: ['N1'], 4: ['Z1'] });
  const r = mergePhone(a, b, KNOWN);
  assert.deepEqual(daysOf(r), { 1: ['F1'], 3: ['N1'], 4: ['Z1'] });
  assert.deepEqual(r.warnings, ['El día 2: dos lecturas distintas de la foto, revísalo a mano.']);
});

test('mergePhone: el orden de los códigos no es un conflicto', () => {
  const r = mergePhone(R({ 5: ['F1', 'F52'] }), R({ 5: ['F52', 'F1'] }), KNOWN);
  assert.deepEqual(daysOf(r), { 5: ['F1', 'F52'] });
});

test('mergePhone: 2 o más conflictos → solo valen los días en que coinciden', () => {
  const a = R({ 1: ['F1'], 2: ['S1'], 3: ['N1'], 4: ['F1'], 5: ['Z1'] });
  const b = R({ 1: ['F1'], 2: ['F1'], 3: ['S1'], 6: ['N1'] });
  const r = mergePhone(a, b, KNOWN);
  assert.deepEqual(daysOf(r), { 1: ['F1'] });
  assert.deepEqual(r.warnings, ['Los días 2, 3, 4, 5 y 6: dos lecturas distintas de la foto, revísalos a mano.']);
});

test('mergePhone: mes distinto → mes null y aviso; sin conflictos se conservan los días', () => {
  const r = mergePhone(R({ 1: ['F1'], 2: ['S1'] }), R({ 2: ['S1'], 3: ['N1'] }, { month: 11 }), KNOWN);
  assert.equal(r.month, null);
  assert.equal(r.year, 2026);
  assert.deepEqual(daysOf(r), { 1: ['F1'], 2: ['S1'], 3: ['N1'] });
  assert.deepEqual(r.warnings, ['No estoy seguro del mes: elígelo tú.']);
});

test('mergePhone: mes distinto y algún conflicto (o ningún día en común) → solo lo que coincide', () => {
  const r1 = mergePhone(R({ 1: ['F1'], 2: ['S1'], 3: ['N1'] }), R({ 1: ['F1'], 2: ['N1'], 4: ['Z1'] }, { month: 11 }), KNOWN);
  assert.deepEqual(daysOf(r1), { 1: ['F1'] });
  assert.equal(r1.month, null);
  assert.ok(r1.warnings.includes('Los días 2, 3 y 4: dos lecturas distintas de la foto, revísalos a mano.'), r1.warnings.join(' | '));
  // días disjuntos y meses distintos: no hay nada en común → ningún día
  const r2 = mergePhone(R({ 1: ['F1'], 2: ['S1'] }), R({ 20: ['F1'], 21: ['S1'] }, { month: 11 }), KNOWN);
  assert.deepEqual(r2.days, []);
  assert.equal(r2.layout, 'phone-list');
  assert.deepEqual(r2.warnings, ['No estoy seguro del mes: elígelo tú.', 'Los días 1, 2, 20 y 21: dos lecturas distintas de la foto, revísalos a mano.']);
});

test('mergePhone: año distinto, año o mes null en un lector', () => {
  const r = mergePhone(R({ 1: ['F1'] }), R({ 1: ['F1'] }, { year: 2027 }), KNOWN);
  assert.equal(r.month, 10); assert.equal(r.year, null);
  assert.deepEqual(r.warnings, ['No estoy seguro del año: elígelo tú.']);
  // uno null → vale el otro
  const r2 = mergePhone(R({ 1: ['F1'] }, { month: null, year: null }), R({ 1: ['F1'] }), KNOWN);
  assert.equal(r2.month, 10); assert.equal(r2.year, 2026);
  assert.deepEqual(r2.warnings, []);
  // mes sin año
  const r3 = mergePhone(R({ 1: ['F1'] }, { year: null }), null, KNOWN);
  assert.deepEqual(r3.warnings, ['No estoy seguro del año: confírmalo.']);
  // sin mes en la lista del móvil
  const r4 = mergePhone(R({ 1: ['F1'] }, { month: null, year: null }), null, KNOWN);
  assert.deepEqual(r4.warnings, ['No pude leer el mes con seguridad: elígelo a mano.']);
});

test('mergePhone: veto — día leído solo por uno con poca confianza y fila vista sin leer por el otro', () => {
  const a = R({ 1: ['F1'], 7: [['S51', 'S1'], 0.5], 8: [['N1'], 0.6] });
  const b = R({ 1: ['F1'] }, { unread: [7, 8] });
  const r = mergePhone(a, b, KNOWN);
  assert.deepEqual(daysOf(r), { 1: ['F1'], 8: ['N1'] }); // 0,6 ≥ contestedMinConf (0,55)
  assert.deepEqual(r.warnings, ['No pude leer bien el día 7: revísalo a mano.']);
  // sin B no hay veto
  assert.deepEqual(daysOf(mergePhone(a, null, KNOWN)), { 1: ['F1'], 7: ['S51', 'S1'], 8: ['N1'] });
  // unreadWhy también cuenta como "vista"
  const r2 = mergePhone(a, R({ 1: ['F1'] }, { unreadWhy: { 7: 'ilegible' } }), KNOWN);
  assert.deepEqual(daysOf(r2), { 1: ['F1'], 8: ['N1'] });
  // el veto funciona en los dos sentidos (B lee, A vio la fila)
  const r3 = mergePhone(R({ 1: ['F1'] }, { unread: [9] }), R({ 1: ['F1'], 9: [['Z1'], 0.4] }), KNOWN);
  assert.deepEqual(daysOf(r3), { 1: ['F1'] });
});

test('mergePhone: reglas vetoWhy y soloMinConf (desactivadas por defecto)', () => {
  const a = R({ 1: ['F1'], 7: [['S1'], 0.9], 8: [['N1'], 0.3] });
  const b = R({ 1: ['F1'] }, { unreadWhy: { 7: 'dedo' } });
  assert.deepEqual(daysOf(mergePhone(a, b, KNOWN)), { 1: ['F1'], 7: ['S1'], 8: ['N1'] });
  assert.deepEqual(daysOf(mergePhone(a, b, KNOWN, { ...RULES, vetoWhy: ['dedo'] })), { 1: ['F1'], 8: ['N1'] });
  assert.deepEqual(daysOf(mergePhone(a, b, KNOWN, { ...RULES, soloMinConf: 0.5 })), { 1: ['F1'], 7: ['S1'] });
});

test('mergePhone: lugar sin turno ni evento → se omite; TS + lugar y turno + lugar se quedan', () => {
  const a = R({ 1: ['F52'], 2: ['TS', 'F52'], 3: ['F1', 'F52'], 4: ['F52', 'S31'], 5: ['F52', '-'], 6: ['S31'], 7: ['Z1'], 8: ['TS'] });
  const r = mergePhone(a, null, KNOWN);
  assert.deepEqual(daysOf(r), { 2: ['TS', 'F52'], 3: ['F1', 'F52'], 7: ['Z1'], 8: ['TS'] });
  assert.deepEqual(r.warnings, ['No pude leer bien los días 1, 4, 5 y 6: revísalos a mano.']);
  // con la regla desactivada se quedan todos
  assert.equal(mergePhone(a, null, KNOWN, { ...RULES, placeNeedsShift: false }).days.length, 8);
});

test('mergePhone: tipos de los códigos del usuario (codeKinds) → un turno propio de 2 dígitos no se toma por lugar', () => {
  const known = [...KNOWN, 'F12', 'F54'];
  const a = R({ 1: ['F12'], 2: ['F12', 'F52'], 3: ['F54'], 4: ['F54', 'F1'] });
  // sin tipos: F12 y F54 se suponen lugares (como guessCode de core) → 1, 2 y 3 se omiten
  assert.deepEqual(daysOf(mergePhone(a, null, known)), { 4: ['F54', 'F1'] });
  // con tipos: F12 es un turno
  const kinds = { F12: 'shift', F54: 'place' };
  assert.deepEqual(daysOf(mergePhone(a, null, known, RULES, kinds)), { 1: ['F12'], 2: ['F12', 'F52'], 4: ['F54', 'F1'] });
  // un código por defecto redefinido por el usuario
  assert.deepEqual(daysOf(mergePhone(R({ 1: ['F52'] }), null, KNOWN, RULES, { F52: 'shift' })), { 1: ['F52'] });
  // 'other' (código propio con horario) también hace creíble el lugar
  assert.deepEqual(daysOf(mergePhone(R({ 1: ['XY', 'F52'] }), null, [...KNOWN, 'XY'], RULES, { XY: 'other' })), { 1: ['XY', 'F52'] });
});

test('codeKind: codeKinds → códigos por defecto → forma', () => {
  assert.equal(codeKind('F1'), 'shift');
  assert.equal(codeKind('F52'), 'place');
  assert.equal(codeKind('TS'), 'event');
  assert.equal(codeKind('-'), 'off');
  assert.equal(codeKind('W-'), 'wish');
  assert.equal(codeKind('U'), 'vacation');
  assert.equal(codeKind('Q7'), 'shift');
  assert.equal(codeKind('F59'), 'place');
  assert.equal(codeKind('ABC'), 'other');
  assert.equal(codeKind('F59', { F59: 'shift' }), 'shift');
  assert.equal(codeKind('F1', { F1: 'sick' }), 'sick');
});

test('mergePhone: código nuevo y OCR que no arranca', () => {
  const r = mergePhone(R({ 1: ['F4'], 2: ['F1'] }), null, KNOWN);
  assert.deepEqual(r.warnings, ['Código nuevo: F4 — confirma su horario.']);
  const a = R({}, { layout: 'unknown', month: null, year: null, warnings: ['No pude cargar el lector de texto (OCR).'], ocrFailed: true });
  const r2 = mergePhone(a, null, KNOWN);
  assert.deepEqual(r2.warnings, [OCR_FAILED]);
  assert.equal(r2.layout, 'unknown');
});

test('mergePhone: sin días → el motivo de cada lector, sin repetir el de "no encuentro la lista"', () => {
  const a = R({}, { layout: 'unknown', month: null, year: null, warnings: ['No encontré la lista de turnos en la foto.'] });
  const b = R({}, { layout: 'unknown', month: null, year: null, warnings: ['No encuentro la lista de turnos en la foto. Haz la foto recta y que se vea la pantalla entera.'] });
  const r = mergePhone(a, b, KNOWN);
  assert.deepEqual(r.warnings, ['No encuentro la lista de turnos en la foto. Haz la foto recta y que se vea la pantalla entera.']);
  assert.equal(r.layout, 'unknown');
  // "solo leo la lista del móvil" no se repite y la disposición pc-grid se mantiene
  const pc = R({}, { layout: 'pc-grid', warnings: ['Parece la tabla mensual del PC: aquí solo leo la lista del móvil.'] });
  const r2 = mergePhone(pc, R({}, { layout: 'unknown', warnings: [] }), KNOWN);
  assert.equal(r2.layout, 'pc-grid');
  assert.deepEqual(r2.warnings, ['No pude leer ningún día con seguridad.']);
  // filas vistas y no leídas: ese aviso basta
  const r3 = mergePhone(R({}, { unread: [4, 5], warnings: ['No pude leer bien 2 días de la foto: revísalos a mano.'] }), null, KNOWN);
  assert.deepEqual(r3.warnings, ['No pude leer bien los días 4 y 5: revísalos a mano.']);
});

test('mergePhone: filas no leídas que el otro lector sí leyó no generan aviso', () => {
  const r = mergePhone(R({ 1: ['F1'] }, { unread: [2] }), R({ 1: ['F1'], 2: [['S1'], 0.9] }, { unread: [3] }), KNOWN);
  assert.deepEqual(daysOf(r), { 1: ['F1'], 2: ['S1'] });
  assert.deepEqual(r.warnings, ['No pude leer bien el día 3: revísalo a mano.']);
});

// ---------- avisos ----------

test('dedupeWarnings: repetidos, variantes de la misma frase y el aviso de OCR', () => {
  assert.deepEqual(dedupeWarnings(['Uno.', 'Uno.', ' Uno ', 'uno…', 'Dos', '', null, 3]), ['Uno.', 'Dos']);
  assert.deepEqual(dedupeWarnings([
    'No encontré la lista de turnos en la foto.',
    'Otro aviso.',
    'No reconozco la app de turnos (falta la cabecera naranja). ¿Es una foto de la lista del móvil?',
    'No encuentro la lista de turnos en la foto.',
  ]), ['No reconozco la app de turnos (falta la cabecera naranja). ¿Es una foto de la lista del móvil?', 'Otro aviso.']);
  assert.deepEqual(dedupeWarnings([OCR_FAILED, 'No se pudo iniciar el lector de texto (OCR).']), [OCR_FAILED]);
  assert.deepEqual(dedupeWarnings(undefined), []);
});

// ---------- sanitize ----------

test('sanitize: forma del contrato', () => {
  assert.equal(sanitize(null), null);
  assert.equal(sanitize('x'), null);
  const r = sanitize({
    layout: 'tabla', month: 13, year: 1999,
    days: [
      { day: 3, codes: ['F1', 'F1'], confidence: 0.876 },
      { day: 1, codes: ['S1'], confidence: 7 },
      { day: 3, codes: ['N1'], confidence: 0.9 },  // repetido: vale el primero
      { day: 0, codes: ['F1'] }, { day: 32, codes: ['F1'] }, { day: 2.5, codes: ['F1'] },
      { day: 4, codes: 'F1' }, { day: 5, codes: ['F1', ''] }, { day: 6, codes: [3] },
      { day: '7', codes: [], confidence: 'x' },
      null,
    ],
    warnings: ['Hola', '', 4, null],
    unread: [2, 0, 40, 'x', 9], unreadWhy: { 9: 'ilegible' }, debug: { overlay: 'data:' },
  });
  assert.equal(r.layout, 'unknown');
  assert.equal(r.month, null); assert.equal(r.year, null);
  assert.deepEqual(r.days, [{ day: 1, codes: ['S1'], confidence: 1 }, { day: 3, codes: ['F1'], confidence: 0.88 }, { day: 7, codes: [], confidence: 0.5 }]);
  assert.deepEqual(r.warnings, ['Hola']);
  assert.deepEqual(r.unread, [2, 9]);
  assert.deepEqual(r.unreadWhy, { 9: 'ilegible' });
  assert.equal(r.ocrFailed, undefined);
  assert.deepEqual(r.debug, { overlay: 'data:' });
  const ok = sanitize({ layout: 'pc-grid', month: 6, year: 2026, days: [], warnings: ['No pude cargar el lector de texto (OCR).'] });
  assert.equal(ok.layout, 'pc-grid'); assert.equal(ok.month, 6); assert.equal(ok.year, 2026);
  assert.equal(ok.ocrFailed, true);
  assert.equal('unread' in ok, false);
});

// ---------- looksIncomplete ----------

test('looksIncomplete: cuándo se ejecuta B', () => {
  const full = R(week(1, 11));
  assert.equal(looksIncomplete(full), false);
  assert.equal(looksIncomplete(R(week(1, 10))), true);                       // < 11 días
  assert.equal(looksIncomplete(R(week(1, 10)), { ...RULES, minDaysA: 10 }), false);
  assert.equal(looksIncomplete({ ...full, layout: 'unknown' }), true);
  assert.equal(looksIncomplete({ ...full, layout: 'pc-grid' }), true);
  assert.equal(looksIncomplete({ ...full, month: null }), true);
  assert.equal(looksIncomplete({ ...full, year: null }), true);
  assert.equal(looksIncomplete({ ...full, failed: 'a' }), true);
  assert.equal(looksIncomplete({ ...full, unread: [12] }), true);
  assert.equal(looksIncomplete({ ...full, unread: [] }), false);
  assert.equal(looksIncomplete({ ...full, warnings: ['algo'] }), true);
});

// ---------- recognize() sin Tesseract ----------

test('recognize: sin Tesseract → aviso de conexión, ocrFailed y progreso que acaba en (1, Listo)', async () => {
  const prog = [];
  const r = await recognize({ width: 10, height: 10 }, { onProgress: (f, l) => prog.push([f, l]), tesseract: { langPathLegacy: 'x' } });
  assert.deepEqual(r.warnings, [OCR_FAILED]);
  assert.equal(r.ocrFailed, true);
  assert.deepEqual(r.days, []);
  assert.deepEqual(prog, [[0, 'Leyendo la foto…'], [1, 'Listo']]);
});

// ---------- ocr-pool con un Tesseract falso ----------

// Worker falso de tesseract.js
function fakeWorker(log) {
  return {
    setParameters: async () => {},
    recognize: async () => ({ data: { text: 'F1', confidence: 90, blocks: [] } }),
    terminate: async () => { log.terminated++; },
  };
}
// Tesseract falso: mode = 'ok' | 'lang-error' (errorHandler, la promesa no se resuelve nunca) | 'hang' | 'late'
function fakeTesseract(mode, log) {
  return {
    createWorker: (lang, oem, opts) => {
      log.calls++; log.opts = opts;
      if (mode === 'ok') return Promise.resolve(fakeWorker(log));
      if (mode === 'lang-error') { setTimeout(() => opts.errorHandler('Network error while fetching eng.traineddata.gz'), 5); return new Promise(() => {}); }
      if (mode === 'late') return new Promise((res) => setTimeout(() => res(fakeWorker(log)), 120));
      return new Promise(() => {});
    },
  };
}
const TESS = defaultPaths();
const newLog = () => ({ calls: 0, terminated: 0, opts: null });
async function withTesseract(mode, fn) {
  const log = newLog();
  const prev = globalThis.Tesseract;
  globalThis.Tesseract = fakeTesseract(mode, log);
  try { await disposePool(); await fn(log); } finally { await disposePool(); setStartTimeout(45000); globalThis.Tesseract = prev; }
}
const since = (t0) => Date.now() - t0;

test('pool: arranca con workerBlobURL: false, lee y dispose() lo termina', () => withTesseract('ok', async (log) => {
  const data = await recognizeImage(TESS, {}, { psm: 7 });
  assert.equal(data.text, 'F1');
  assert.equal(log.opts.workerBlobURL, false);
  assert.equal(typeof log.opts.errorHandler, 'function');
  assert.equal(poolInfo().workers, 1);
  await disposePool();
  assert.equal(log.terminated, 1);
  assert.deepEqual([poolInfo().workers, poolInfo().creating, poolInfo().starting], [0, false, 0]);
}));

test('pool: fallo al cargar el idioma (errorHandler) → rechaza enseguida y se recuerda hasta dispose()', () => withTesseract('lang-error', async (log) => {
  const t0 = Date.now();
  await assert.rejects(ready(TESS), /Network error/);
  assert.ok(since(t0) < 1000);
  assert.deepEqual([poolInfo().workers, poolInfo().creating, poolInfo().starting], [0, false, 0]);
  assert.ok(startErrorFor(TESS));
  // la siguiente llamada no vuelve a crear el worker
  await assert.rejects(recognizeImage(TESS, {}, {}), /Network error/);
  assert.equal(log.calls, 1);
  // otras rutas no heredan el error
  assert.equal(startErrorFor({ ...TESS, langPath: 'http://x/otro/' }), null);
  await disposePool();
  assert.equal(startErrorFor(TESS), null);
  await assert.rejects(ready(TESS), /Network error/);
  assert.equal(log.calls, 2);
}));

test('pool: descarga colgada → tiempo máximo configurable', () => withTesseract('hang', async () => {
  setStartTimeout(60);
  const t0 = Date.now();
  await assert.rejects(ready(TESS), /sin respuesta/);
  assert.ok(since(t0) >= 50 && since(t0) < 1000);
  assert.deepEqual([poolInfo().workers, poolInfo().creating, poolInfo().starting], [0, false, 0]);
}));

test('pool: un worker que llega tarde (tras el tiempo máximo) se termina', () => withTesseract('late', async (log) => {
  setStartTimeout(30);
  await assert.rejects(ready(TESS), /sin respuesta/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(log.terminated, 1);
  assert.equal(poolInfo().workers, 0);
}));

test('pool: dispose() durante un arranque colgado termina enseguida y vacía el pool', () => withTesseract('hang', async () => {
  const p = ready(TESS);
  assert.equal(poolInfo().starting, 1);
  const t0 = Date.now();
  await disposePool();
  assert.ok(since(t0) < 2000);
  await assert.rejects(p, /OCR cancelado/);
  assert.deepEqual([poolInfo().workers, poolInfo().creating, poolInfo().starting, poolInfo().queued], [0, false, 0, 0]);
  assert.equal(startErrorFor(TESS), null); // cancelar no es un fallo de arranque
}));

test('pool: una lectura de una época anterior a dispose() no vuelve a crear workers', () => withTesseract('ok', async (log) => {
  const old = { ...TESS, epoch: poolEpoch() };
  await recognizeImage(old, {}, {});
  assert.equal(log.calls, 1);
  await disposePool();
  await assert.rejects(ready(old), /OCR cancelado/);
  await assert.rejects(recognizeImage(old, {}, {}), /OCR cancelado/);
  assert.equal(log.calls, 1);
  assert.deepEqual([poolInfo().workers, poolInfo().creating, poolInfo().queued], [0, false, 0]);
  // la época nueva sí
  await recognizeImage({ ...TESS, epoch: poolEpoch() }, {}, {});
  assert.equal(log.calls, 2);
}));

test('recognize: con el OCR caído hace poco no vuelve a esperar', () => withTesseract('lang-error', async () => {
  await assert.rejects(ready(TESS));
  const t0 = Date.now();
  const r = await recognize({ width: 10, height: 10 });
  assert.ok(since(t0) < 200);
  assert.deepEqual(r.warnings, [OCR_FAILED]);
  assert.equal(r.ocrFailed, true);
}));

// ---------- ocr-pool: conversión del lienzo y dispose() a mitad de una lectura ----------

// Tesseract falso que apunta las llamadas; tras terminate(), llamar al worker es un error (como tesseract.js)
function recordingTesseract(log, { setParamsMs = 0 } = {}) {
  const make = () => {
    let dead = false;
    return {
      setParameters: async (p) => {
        if (dead) throw new TypeError('worker terminado');
        if ('debug_file' in p) return;
        log.setParams.push(p);
        if (setParamsMs) await new Promise((r) => setTimeout(r, setParamsMs));
      },
      recognize: async (image) => {
        if (dead) throw new TypeError('worker terminado');
        log.images.push(image);
        return { data: { text: 'F1', confidence: 90, blocks: [] } };
      },
      terminate: async () => { dead = true; log.terminated++; },
    };
  };
  return { createWorker: () => { log.calls++; return Promise.resolve(make()); } };
}
async function withRecording(opts, fn) {
  const log = { calls: 0, terminated: 0, setParams: [], images: [] };
  const prev = globalThis.Tesseract;
  globalThis.Tesseract = recordingTesseract(log, opts);
  try { await disposePool(); await fn(log); } finally { await disposePool(); globalThis.Tesseract = prev; }
}
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
// Lienzo falso: toBlob (HTMLCanvasElement) o convertToBlob (OffscreenCanvas), con retraso opcional
const fakeCanvas = (ms = 0, bytes = PNG) => ({ toBlob: (cb) => setTimeout(() => cb(bytes && new Blob([bytes], { type: 'image/png' })), ms) });
const fakeOffscreen = () => ({ convertToBlob: async () => new Blob([PNG], { type: 'image/png' }) });
const bytesOf = (b) => [...new Uint8Array(b)];

test('pool: el lienzo llega a tesseract como bytes PNG (toBlob y convertToBlob); Blob → bytes; otros tal cual', () => withRecording({}, async (log) => {
  await recognizeImage(TESS, fakeCanvas(), {});
  await recognizeImage(TESS, fakeOffscreen(), {});
  await recognizeImage(TESS, new Blob([PNG]), {});
  const other = { width: 1 };
  await recognizeImage(TESS, other, {});
  assert.equal(log.images.length, 4);
  for (const im of log.images.slice(0, 3)) assert.deepEqual(bytesOf(im), [...PNG]);
  assert.equal(log.images[3], other);
}));

test('pool: lienzo que no se puede leer (toBlob da null) → la lectura falla, no se cuelga', () => withRecording({}, async (log) => {
  await assert.rejects(recognizeImage(TESS, fakeCanvas(0, null), {}), /no se pudo leer el lienzo/);
  assert.equal(log.images.length, 0);
  // el worker sigue sirviendo
  assert.equal((await recognizeImage(TESS, fakeCanvas(), {})).text, 'F1');
}));

test('pool: dispose() mientras se convierte el lienzo → no se llama a tesseract y la lectura se cancela', () => withRecording({}, async (log) => {
  await ready(TESS);
  const p = recognizeImage(TESS, fakeCanvas(60), { psm: 6 });
  await new Promise((r) => setTimeout(r, 15));
  await disposePool();
  await assert.rejects(p, /OCR cancelado/);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([log.setParams.length, log.images.length, log.terminated], [0, 0, 1]);
  assert.deepEqual([poolInfo().workers, poolInfo().queued], [0, 0]);
}));

test('pool: dispose() durante setParameters → no se llama a recognize', () => withRecording({ setParamsMs: 60 }, async (log) => {
  await ready(TESS);
  const p = recognizeImage(TESS, fakeCanvas(), { psm: 6 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(log.setParams.length, 1);
  await disposePool();
  await assert.rejects(p, /OCR cancelado/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(log.images.length, 0);
  // y se puede volver a leer con un worker nuevo
  assert.equal((await recognizeImage(TESS, fakeCanvas(), {})).text, 'F1');
  assert.equal(log.calls, 2);
}));
