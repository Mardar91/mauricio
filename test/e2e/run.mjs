// Tests de interfaz con Playwright (Chromium, pantalla tipo iPhone). Uso: npm run e2e [-- filtro]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/serve.mjs';
import {
  KEY, OWNER, REPO, ROOT, STORAGE_KEY, SYNC, TOKEN, core, demoState, ensureOut, fakeGitHub, findOverflow, iphoneContext,
  mockNetwork, preparePage, seedRemote,
} from './helpers.mjs';

const filter = process.argv.slice(2).join(' ');
const server = await startServer(0);
const APP = `${server.url}/docs/`;
const PHOTO = path.join(ROOT, 'test/fotos/phone-2026-10-b.jpg');
const browser = await chromium.launch();
ensureOut();

// Reconocedor "stub" (no lee nada): fuerza el plan B aunque el real ya esté integrado
const STUB = `export async function recognize(input, o = {}) { o.onProgress?.(0.5, 'Leyendo…'); o.onProgress?.(1, 'Listo');
  return { layout: 'unknown', month: null, year: null, days: [], warnings: ['No se pudo leer la foto automáticamente.'] }; }
export async function dispose() {}`;

const tests = [];
const openContexts = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, opts });

// Abre la app con un estado inicial; devuelve { page, ctx, errors, net }.
// standalone: true = app abierta desde la pantalla de inicio; false = pestaña de Safari (iPhone)
async function openApp({ state = null, sw = 'block', width = 390, hash = '', net = true, standalone = true, ios = true, gh } = {}) {
  const ctx = await iphoneContext(browser, { scale: 1, sw, width, ios });
  openContexts.push(ctx);
  const errors = [];
  const page = await preparePage(ctx, { state, errors, standalone });
  const log = net ? await mockNetwork(page, { gh }) : null;
  await page.goto(APP + hash);
  await page.waitForSelector('.tabbar', { state: 'attached' });
  return { page, ctx, errors, net: log };
}

// Estado conectado (sync activa) de este teléfono
const connected = (extra = {}) => core.updateSettings(demoState(), { sync: { ...SYNC, deviceId: 'iphone1', ...extra } });
const setupHash = (cfg = {}) => core.buildSetupLink(APP, { owner: OWNER, repo: REPO, branch: '', token: TOKEN, key: KEY, ...cfg }).slice(APP.length);
const waitState = (page, fn, arg, timeout = 10000) => page.waitForFunction(([k, src, a]) => {
  const st = JSON.parse(localStorage.getItem(k) || 'null');
  return st && new Function('s', 'a', `return (${src})(s, a)`)(st, a);
}, [STORAGE_KEY, fn.toString(), arg], { timeout });

const getState = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
const tab = (page, id) => page.click(`.tab[data-tab="${id}"]`);
const text = (page, sel) => page.locator(sel).first().innerText();
const visible = (page, sel) => page.locator(sel).first().isVisible();

async function sheetOpen(page) {
  await page.waitForSelector('.sheet-wrap.open .sheet');
  await page.waitForTimeout(380);
}

// ---------------------------------------------------------------------------

test('primer uso: la bienvenida se puede saltar y no vuelve a salir', async () => {
  const { page, ctx, errors } = await openApp();
  await page.waitForSelector('.onboarding.open');
  assert.match(await text(page, '.ob-title'), /Hola, Mauricio/);
  await page.click('.ob-skip');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  assert.match(await text(page, '#view-hoy'), /Aún no tienes turnos/);
  assert.equal((await getState(page)).settings.onboardingDone, true);
  await page.reload();
  await page.waitForSelector('.tabbar');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.onboarding').count(), 0, 'la bienvenida no debe volver a salir');
  // El botón grande del estado vacío lleva a Escanear
  await page.click('#view-hoy .empty .btn-primary');
  assert.ok(await visible(page, '#view-escanear'));
  return { ctx, errors };
});

test('primer uso en Safari (iPhone sin instalar): paso de instalar, se queda en Hoy con el aviso fijo', async () => {
  const { page, ctx, errors } = await openApp({ standalone: false });
  await page.waitForSelector('.onboarding.open');
  const steps = await page.locator('.ob-dot').count();
  assert.equal(steps, 3, 'en iPhone (Safari) se muestra el paso de instalar');
  await page.click('.ob-bottom .btn-primary');
  const install = await text(page, '.ob-step');
  assert.match(install, /Agregar a inicio/);
  assert.match(install, /Añadir a pantalla de inicio/);
  for (let i = 1; i < steps; i++) await page.click('.ob-bottom .btn-primary');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  assert.ok(await visible(page, '#view-hoy'), 'en Safari no lleva a escanear');
  assert.match(await text(page, '[data-testid="banner-safari"]'), /Instala la app para no perder tus datos/);
  await page.click('[data-testid="banner-safari"] .banner-btn');
  await sheetOpen(page);
  assert.match(await text(page, '.sheet-install'), /Compartir/);
  // También en Escanear
  await page.click('.sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await tab(page, 'escanear');
  assert.ok(await visible(page, '#view-escanear [data-testid="banner-safari"]'));
  return { ctx, errors };
});

test('primer uso en la app instalada: completar la bienvenida lleva a Escanear, sin aviso de Safari', async () => {
  const { page, ctx, errors } = await openApp({ standalone: true });
  await page.waitForSelector('.onboarding.open');
  assert.equal(await page.locator('.ob-dot').count(), 2, 'sin paso de instalar');
  for (let i = 0; i < 2; i++) await page.click('.ob-bottom .btn-primary');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  assert.ok(await visible(page, '#view-escanear'));
  assert.equal(await page.locator('[data-testid="banner-safari"]').count(), 0);
  return { ctx, errors };
});

test('pestañas: navegación y contenido de Hoy', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  const hoy = await text(page, '#view-hoy');
  assert.match(hoy, /Próximo turno/i);
  assert.match(hoy, /Tarde/);
  assert.match(hoy, /empieza en 3 h 15 min/);
  assert.match(hoy, /Esta semana/);
  for (const id of ['calendario', 'escanear', 'horas', 'ajustes', 'hoy']) {
    await tab(page, id);
    assert.ok(await visible(page, `#view-${id}`), `vista ${id} visible`);
    assert.equal(await page.locator('.view:not([hidden])').count(), 1, 'solo una vista a la vez');
    assert.equal(await page.getAttribute(`.tab[data-tab="${id}"]`, 'aria-current'), 'page');
  }
  // "Ver mes" lleva al calendario
  await page.click('#view-hoy .section-head .link-btn');
  assert.ok(await visible(page, '#view-calendario'));
  assert.match(await text(page, '.nav-title'), /Octubre 2026/);
  return { ctx, errors };
});

test('calendario: editar un día actualiza las horas de la semana y del mes (y se puede deshacer)', async () => {
  const state = demoState();
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'calendario');
  const weekSel = '.week[data-week="2026-10-12"] .week-sep-hours';
  const before = core.weekSummary(state, '2026-10-12').total;
  assert.match(await text(page, weekSel), new RegExp(core.formatHours(before)));
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="F1"]');
  assert.match(await text(page, '.de-summary'), /8 h 30/);
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.match(await text(page, weekSel), new RegExp(core.formatHours(before + 510)));
  assert.match(await text(page, '.day-row[data-key="2026-10-14"]'), /06:00–15:00/);
  const s = await getState(page);
  assert.deepEqual(s.days['2026-10-14'].codes, ['F1']);
  assert.equal(s.changes.at(-1).source, 'manual');
  // Horas del mes
  await tab(page, 'horas');
  const month = core.monthSummary(core.setDay(state, '2026-10-14', ['F1']), 2026, 10).total;
  assert.match(await text(page, '.hours-summary'), new RegExp(core.formatHours(month)));
  // Deshacer desde el aviso
  await page.click('.toast-action');
  await page.waitForTimeout(200);
  assert.deepEqual((await getState(page)).days['2026-10-14'].codes, ['-']);
  return { ctx, errors };
});

test('editar día: cerrar con cambios sin guardar pide confirmación', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="S1"]');
  await page.click('.sheet-wrap .backdrop', { position: { x: 20, y: 20 } });
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Salir sin guardar/);
  await page.click('.dialog-wrap.open .dialog .btn-secondary'); // Seguir editando
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  assert.ok(await visible(page, '.sheet-day'), 'la hoja sigue abierta');
  await page.click('.sheet-close');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-danger');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.deepEqual((await getState(page)).days['2026-10-14'].codes, ['-'], 'no se guardó nada');
  // Sin cambios se cierra sin preguntar
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheetOpen(page);
  await page.click('.sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.equal(await page.locator('.dialog-wrap').count(), 0);
  return { ctx, errors };
});

test('calendario: navegar meses, botón Hoy y borrar un día', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'calendario');
  await page.click('button[aria-label="Mes anterior"]');
  assert.match(await text(page, '.nav-title'), /Septiembre 2026/);
  await page.click('.today-btn');
  assert.match(await text(page, '.nav-title'), /Octubre 2026/);
  await page.click('.day-row[data-key="2026-10-20"]');
  await sheetOpen(page);
  await page.click('.sheet-day .btn-danger-plain');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-danger');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.equal((await getState(page)).days['2026-10-20'], undefined);
  return { ctx, errors };
});

test('escanear: foto con el reconocedor stub → plan B a mano → guardar → se ve en el calendario', async () => {
  const s = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  const { page, ctx, errors } = await openApp({ state: s });
  await page.route('**/docs/js/recognize/index.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
  await tab(page, 'escanear');
  assert.equal(await page.getAttribute('input[data-testid="scan-camera"]', 'capture'), 'environment');
  assert.notEqual(await page.getAttribute('input[data-testid="scan-pick"]', 'multiple'), null);
  await page.setInputFiles('input[data-testid="scan-pick"]', PHOTO);
  await page.waitForSelector('.fallback');
  assert.match(await text(page, '.fallback'), /No pude leer la foto/);
  assert.equal(await page.evaluate(() => typeof window.Tesseract), 'object', 'tesseract.min.js cargado antes de reconocer');
  // La foto se ve en grande dentro de la app (no en otra pestaña)
  await page.click('.fallback .photo-strip-item');
  await sheetOpen(page);
  assert.ok(await visible(page, '.sheet-photo .photo-full'));
  await page.click('.sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.selectOption('.fallback .month-picker select >> nth=0', '10');
  await page.selectOption('.fallback .month-picker select >> nth=1', '2026');
  await page.click('[data-testid="fallback-manual"]');
  await page.waitForSelector('.review-list');
  assert.equal(await page.locator('.review-row').count(), 31);
  assert.ok(await page.locator('[data-testid="review-save"]').isDisabled());
  await page.click('.review-row[data-day="22"] .review-main');
  await sheetOpen(page);
  assert.ok(await visible(page, '.sheet-day .de-photo-btn'), 'la foto sigue a mano mientras se elige el turno');
  await page.click('.sheet .tile[data-code="N1"]');
  // «Día 23 ›» guarda este y abre el siguiente
  assert.match(await text(page, '[data-testid="day-next"]'), /23/);
  await page.click('[data-testid="day-next"]');
  await page.waitForFunction(() => /23/.test(document.querySelector('.sheet-wrap.open .sheet-title')?.textContent || ''));
  await page.waitForTimeout(380);
  await page.click('[data-testid="day-done"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.click('.review-row[data-day="26"] .review-main');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="F1"]');
  await page.click('.sheet .tile[data-code="TS"]');
  await page.click('[data-testid="day-done"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.match(await text(page, '[data-testid="review-save"]'), /Guardar 2 días/);
  await page.click('[data-testid="review-save"]');
  await page.waitForSelector('#view-calendario:not([hidden])');
  assert.match(await text(page, '.nav-title'), /Octubre 2026/);
  assert.equal(await page.locator('.day-row[data-key="2026-10-22"] .badge[aria-label^="N1"]').count(), 1);
  assert.equal(await page.locator('.day-row[data-key="2026-10-26"] .badge[aria-label^="TS"]').count(), 1);
  const st = await getState(page);
  assert.deepEqual(st.days['2026-10-22'].codes, ['N1']);
  assert.deepEqual(st.days['2026-10-26'].codes, ['F1', 'TS']);
  assert.equal(st.days['2026-10-26'].source, 'manual', 'escrito a mano');
  assert.equal(Object.keys(st.days).length, 2);
  assert.equal(st.scans.length, 0, 'no cuenta como escaneo leído');
  assert.equal(await page.evaluate(() => localStorage.getItem('turnos-mauricio:scan-draft')), null, 'el borrador se borra al guardar');
  return { ctx, errors };
});

test('escanear: el reconocedor actual procesa una foto sin errores (revisión o plan B)', async () => {
  const s = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  const { page, ctx, errors } = await openApp({ state: s });
  let opts = null;
  await page.exposeFunction('__seenOpts', (o) => { opts = o; });
  await page.route('**/docs/js/recognize/index.js*', async (r) => {
    // Envuelve el reconocedor real (index.js?real) para ver las opciones que le pasa la UI
    if (r.request().url().includes('?real')) return r.continue();
    r.fulfill({ contentType: 'text/javascript', body: `import * as real from './index.js?real';
      export async function recognize(input, options = {}) {
        window.__seenOpts?.({ keys: Object.keys(options), tess: Object.keys(options.tesseract || {}), kinds: options.codeKinds || null });
        return real.recognize(input, options);
      }
      export const dispose = (...a) => real.dispose(...a);` });
  });
  await tab(page, 'escanear');
  await page.setInputFiles('input[data-testid="scan-pick"]', PHOTO);
  await page.waitForSelector('.fallback, .review-list', { timeout: 90000 });
  assert.ok(opts, 'la UI llama al reconocedor');
  assert.ok(!opts.tess.includes('langPathLegacy'), 'sin langPathLegacy');
  assert.equal(opts.kinds?.F1, 'shift');
  assert.equal(opts.kinds?.S51, 'place');
  return { ctx, errors };
}, { slow: true });

test('escanear: si el lector de texto no arranca → «Reintentar» (libera y vuelve a leer)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  let calls = 0, disposed = 0;
  await page.exposeFunction('__rec', (k) => { if (k === 'r') calls++; else disposed++; });
  await page.route('**/docs/js/recognize/index.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `
    export async function recognize() { window.__rec('r'); return { layout: 'unknown', month: null, year: null, days: [], ocrFailed: true,
      warnings: ['No se pudo iniciar el lector de texto. Comprueba la conexión a internet y vuelve a intentarlo.'] }; }
    export async function dispose() { window.__rec('d'); }` }));
  await tab(page, 'escanear');
  await page.setInputFiles('input[data-testid="scan-pick"]', PHOTO);
  await page.waitForSelector('[data-testid="ocr-failed"]');
  assert.match(await text(page, '[data-testid="ocr-failed"]'), /No se pudo iniciar el lector de texto/);
  await page.click('[data-testid="ocr-retry"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="ocr-failed"]'));
  await page.waitForTimeout(200);
  assert.equal(calls, 2, 'vuelve a leer la misma foto');
  assert.ok(disposed >= 1, 'libera el lector antes de reintentar');
  return { ctx, errors };
});

test('revisión: resultado inyectado con día cambiado, dudoso, nuevo y código nuevo', async () => {
  const state = demoState();
  delete state.days['2026-10-27'];
  const { page, ctx, errors } = await openApp({ state });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), {
    layout: 'phone-list', month: 10, year: 2026,
    days: [
      { day: 13, codes: ['S1', 'S51'], confidence: 0.97 },
      { day: 14, codes: ['F1'], confidence: 0.9 },
      { day: 16, codes: ['F1'], confidence: 0.45 },
      { day: 27, codes: ['F4'], confidence: 0.88 },
    ],
    warnings: ['La foto 2 es de septiembre 2026: escanéala aparte.'],
  });
  await page.waitForSelector('.review-list');
  const row = (d) => `.review-row[data-day="${d}"]`;
  assert.match(await text(page, row(13)), /Sin cambios/);
  assert.match(await text(page, row(14)), /Cambia: libre → F1/);
  assert.match(await text(page, row(16)), /Revisar/);
  assert.match(await text(page, row(27)), /Nuevo/);
  assert.match(await text(page, '#view-escanear'), /Código nuevo: F4/);
  assert.match(await text(page, '#view-escanear'), /escanéala aparte/);
  assert.match(await text(page, '.review-counts'), /4.*días leídos/s);
  assert.match(await text(page, '.review-counts'), /1 nuevo\b/);
  assert.match(await text(page, '.review-counts'), /1 cambia\b/);
  assert.match(await text(page, '.review-counts'), /1 por revisar/);
  assert.match(await text(page, '[data-testid="review-save"]'), /Guardar 2 días/);
  // El dudoso no se guarda hasta marcarlo
  await page.check(`${row(16)} .check`);
  assert.match(await text(page, '[data-testid="review-save"]'), /Guardar 3 días/);
  // Cambiar el mes reetiqueta los días (y vuelve)
  await page.selectOption('.review-month select >> nth=0', '11');
  assert.match(await text(page, row(14)), /Nuevo/);
  await page.selectOption('.review-month select >> nth=0', '10');
  await page.check(`${row(16)} .check`);
  await page.click('[data-testid="review-save"]');
  await page.waitForSelector('#view-calendario:not([hidden])');
  const s = await getState(page);
  assert.equal(s.days['2026-10-14'].source, 'scan');
  assert.equal(s.scans.at(-1).daysFound, 4);
  assert.deepEqual(s.days['2026-10-14'].codes, ['F1']);
  assert.deepEqual(s.days['2026-10-16'].codes, ['F1']);
  assert.deepEqual(s.days['2026-10-27'].codes, ['F4']);
  assert.equal(s.codes.F4.confirmed, false);
  // Ajustes avisa del horario sin confirmar (y la pestaña lleva un punto)
  assert.ok(await page.locator('.tab[data-tab="ajustes"] .tab-dot:not([hidden])').count());
  await tab(page, 'ajustes');
  assert.match(await text(page, '.code-row[data-code="F4"]'), /Confirmar/);
  return { ctx, errors };
});

test('revisión: días sin leer y dudosos se muestran y se avisa antes de guardar sin ellos', async () => {
  const state = demoState();
  const { page, ctx, errors } = await openApp({ state });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), {
    layout: 'phone-list', month: 11, year: 2026,
    days: [
      { day: 2, codes: ['F1', 'F51'], confidence: 0.95 },
      { day: 3, codes: ['S1'], confidence: 0.5 },
      { day: 4, codes: ['N1'], confidence: 0.94 },
    ],
    unread: [6],
    warnings: ['No pude leer bien el día 5: revísalo a mano.'],
  });
  await page.waitForSelector('.review-list');
  const row = (d) => `.review-row[data-day="${d}"]`;
  for (const d of [5, 6]) {
    assert.ok(await visible(page, `${row(d)}.unread`), `día ${d} sin leer, a la vista`);
    assert.match(await text(page, row(d)), /No se pudo leer/);
  }
  assert.match(await text(page, '[data-testid="unread-notice"]'), /No se pudieron leer 2 días/);
  assert.match(await text(page, '[data-testid="review-save"]'), /Guardar 2 días/);
  await page.click('[data-testid="review-save"]');
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Faltan 3 días por comprobar/);
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /mar 3, jue 5 y vie 6/i);
  await page.click('.dialog-wrap.open .dialog .btn-secondary'); // Revisar
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  // Completar el día 5 a mano
  await page.click(`${row(5)} .review-main`);
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="S1"]');
  await page.click('[data-testid="day-done"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.match(await text(page, '[data-testid="review-save"]'), /Guardar 3 días/);
  await page.click('[data-testid="review-save"]');
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Faltan 2 días/);
  await page.click('.dialog-wrap.open .dialog .btn-primary'); // Guardar sin ellos
  await page.waitForSelector('#view-calendario:not([hidden])');
  await page.waitForSelector('.toast');
  assert.match(await text(page, '.toast'), /Guardados 3 días de noviembre\. Sin guardar: mar 3 y vie 6/);
  const s = await getState(page);
  assert.deepEqual(s.days['2026-11-05'].codes, ['S1']);
  assert.equal(s.days['2026-11-03'], undefined);
  assert.equal(s.days['2026-11-06'], undefined);
  return { ctx, errors };
});

test('revisión: mes sin leer → selector de mes destacado; plan al día → «Listo»', async () => {
  const state = demoState();
  const { page, ctx, errors } = await openApp({ state });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), {
    layout: 'phone-list', month: null, year: null,
    days: [{ day: 13, codes: ['S1', 'S51'], confidence: 0.97 }, { day: 14, codes: ['-'], confidence: 0.95 }],
    warnings: ['No pude leer el mes con seguridad: elígelo a mano.'],
  });
  await page.waitForSelector('.review-list');
  assert.ok(await visible(page, '[data-testid="review-month"].needs-month'));
  assert.match(await text(page, '[data-testid="review-month"]'), /No se vio el mes/);
  // Octubre: todo coincide con lo guardado
  await page.selectOption('.review-month select >> nth=0', '10');
  assert.ok(!(await visible(page, '[data-testid="review-month"].needs-month')));
  assert.match(await text(page, '[data-testid="up-to-date"]'), /Tu plan ya estaba al día/);
  assert.match(await text(page, '[data-testid="review-save"]'), /Listo/);
  await page.click('[data-testid="review-save"]');
  await page.waitForSelector('#view-calendario:not([hidden])');
  assert.equal((await getState(page)).scans.length, 3, 'se anota el escaneo');
  return { ctx, errors };
});

test('revisión: el borrador sobrevive a una recarga', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), {
    layout: 'phone-list', month: 11, year: 2026,
    days: [{ day: 2, codes: ['F1'], confidence: 0.95 }, { day: 3, codes: ['S1'], confidence: 0.92 }],
    warnings: [],
  });
  await page.waitForSelector('.review-list');
  await page.click('.review-row[data-day="3"] .review-main');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="N1"]');
  await page.click('[data-testid="day-done"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.uncheck('.review-row[data-day="2"] .check');
  await page.reload();
  await page.waitForSelector('.tabbar', { state: 'attached' });
  await page.waitForSelector('#view-escanear:not([hidden]) .review-list');
  assert.match(await text(page, '.review-row[data-day="3"]'), /N1/);
  assert.equal(await page.isChecked('.review-row[data-day="2"] .check'), false);
  assert.match(await text(page, '[data-testid="review-save"]'), /Guardar 1 día\b/);
  assert.equal(await page.inputValue('.review-month select >> nth=0'), '11');
  // Cancelar borra el borrador
  await page.click('[data-testid="review-cancel"]');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-danger');
  await page.waitForSelector('#view-escanear .scan-hero');
  assert.equal(await page.evaluate(() => localStorage.getItem('turnos-mauricio:scan-draft')), null);
  return { ctx, errors };
});

test('revisión: la barra de «Guardar» no se cruza con la barra de pestañas', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), {
    layout: 'phone-list', month: 10, year: 2026,
    days: Array.from({ length: 20 }, (_, i) => ({ day: i + 10, codes: ['F1'], confidence: 0.95 })), warnings: [],
  });
  await page.waitForSelector('.review-list');
  await page.waitForTimeout(400);
  for (const y of [0, 600, 1200]) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const bar = document.querySelector('.review-bar').getBoundingClientRect();
      const tabs = document.querySelector('.tabbar');
      const disc = document.querySelector('.tab-center-disc').getBoundingClientRect();
      const btn = document.querySelector('[data-testid="review-save"]').getBoundingClientRect();
      const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
      return {
        tabsVisible: getComputedStyle(tabs).visibility !== 'hidden' && tabs.getBoundingClientRect().top < innerHeight,
        overlap: !(disc.bottom <= bar.top || disc.top >= bar.bottom || disc.right <= bar.left || disc.left >= bar.right),
        hitSave: Boolean(hit?.closest('[data-testid="review-save"]')),
        inView: btn.bottom <= innerHeight,
      };
    });
    assert.equal(r.tabsVisible, false, 'sin pestañas durante la revisión');
    assert.ok(!r.tabsVisible || !r.overlap, 'sin solaparse');
    assert.ok(r.hitSave, 'el botón Guardar recibe el toque');
    assert.ok(r.inView, 'el botón Guardar se ve');
  }
  // Al salir de la revisión vuelven las pestañas
  await page.click('[data-testid="review-cancel"]');
  await page.waitForSelector('#view-escanear .scan-hero');
  assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('.tabbar')).visibility !== 'hidden'));
  return { ctx, errors };
});

test('«Escribir el plan a mano» muestra los días ya guardados', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'escanear');
  await page.click('[data-testid="scan-manual"]');
  await page.waitForSelector('.review-list');
  assert.equal(await page.locator('.review-row').count(), 31);
  assert.match(await text(page, '.review-head'), /lo que ya tienes guardado/);
  assert.equal(await page.locator('.review-row[data-day="13"] .badge[aria-label^="S1"]').count(), 1);
  await page.click('.review-row[data-day="13"] .review-main');
  await sheetOpen(page);
  assert.equal(await page.locator('.sheet-day .chip-code .badge[aria-label^="S1"]').count(), 1, 'el editor abre con lo guardado');
  assert.equal(await page.locator('.sheet-day .chip-code .badge[aria-label^="S51"]').count(), 1);
  await page.click('[data-testid="day-done"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.ok(await page.locator('[data-testid="review-save"]').isDisabled(), 'sin cambios no hay nada que guardar');
  // Desde Hoy vacío también se llega aquí
  return { ctx, errors };
});

test('códigos: confirmar el horario de F6 cambia las horas; crear un código nuevo desde un día', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'ajustes');
  await page.click('.code-row[data-code="F6"]');
  await sheetOpen(page);
  assert.match(await text(page, '.sheet'), /horario es supuesto/);
  assert.equal(await page.evaluate(() => document.querySelector('.sheet-code .ce-more').open), false, 'tipo, color y forma plegados');
  await page.fill('.sheet-code input[type="time"] >> nth=0', '06:30');
  await page.fill('.sheet-code input[type="time"] >> nth=1', '14:30');
  await page.click('[data-testid="code-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  let s = await getState(page);
  assert.equal(s.codes.F6.start, '06:30');
  assert.equal(s.codes.F6.confirmed, true);
  await tab(page, 'calendario');
  for (let i = 0; i < 4; i++) await page.click('button[aria-label="Mes anterior"]');
  assert.match(await text(page, '.nav-title'), /Junio 2026/);
  assert.match(await text(page, '.day-row[data-key="2026-06-04"]'), /06:30–14:30[\s\S]*7 h 30/);
  // Código nuevo desde el editor de un día
  await page.click('.today-btn');
  await page.click('.day-row[data-key="2026-10-20"]');
  await sheetOpen(page);
  await page.click('.new-code-btn');
  await page.waitForSelector('.sheet-code');
  await page.waitForTimeout(400);
  await page.fill('.sheet-code .input-code', 'x1');
  await page.fill('.sheet-code input[placeholder^="Ej.: Mañana"]', 'Formación');
  await page.fill('.sheet-code input[type="time"] >> nth=0', '08:00');
  await page.fill('.sheet-code input[type="time"] >> nth=1', '12:00');
  await page.selectOption('.sheet-code select', '0');
  await page.click('.sheet-code [data-testid="code-save"]');
  await page.waitForSelector('.sheet-code', { state: 'detached' });
  assert.ok(await page.locator('.sheet-day .chip-code .badge[aria-label^="X1"]').count(), 'el código nuevo queda elegido');
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.match(await text(page, '.day-row[data-key="2026-10-20"]'), /08:00–12:00[\s\S]*4 h/);
  s = await getState(page);
  assert.equal(s.codes.X1.name, 'Formación');
  assert.equal(s.codes.X1.kind, 'shift');
  // Un código repetido da error
  await tab(page, 'ajustes');
  await page.click('[data-testid="code-add"]');
  await page.waitForSelector('.sheet-code');
  await page.waitForTimeout(400);
  await page.fill('.sheet-code .input-code', 'F1');
  await page.fill('.sheet-code input[type="time"] >> nth=0', '08:00');
  await page.fill('.sheet-code input[type="time"] >> nth=1', '12:00');
  await page.click('[data-testid="code-save"]');
  assert.match(await text(page, '.form-error'), /ya existe/);
  return { ctx, errors };
});

test('códigos: cambiar el tipo de un turno pide confirmación antes de quitarle las horas', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'ajustes');
  await page.click('.code-row[data-code="S1"]');
  await sheetOpen(page);
  await page.click('.sheet-code .ce-more > summary');
  await page.click('.sheet-code .choice[data-kind="off"]');
  assert.match(await text(page, '.ce-preview'), /Libre/);
  await page.click('[data-testid="code-save"]');
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /S1 dejará de contar horas/);
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /\d+ días de tu plan/);
  await page.click('.dialog-wrap.open .dialog .btn-secondary');
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  assert.equal((await getState(page)).codes.S1.kind, 'shift', 'no cambió nada');
  return { ctx, errors };
});

test('Ajustes: orden de SPEC §10, códigos usados primero y opciones avanzadas plegadas', async () => {
  const state = demoState();
  for (const [k, d] of Object.entries(state.days)) if (d.codes.includes('F2')) delete state.days[k];
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'ajustes');
  const order = await page.evaluate(() => [...document.querySelectorAll('#view-ajustes .set-group, #view-ajustes details.advanced')].map((x) => x.id).filter(Boolean));
  assert.deepEqual(order.slice(0, 4), ['set-calendar', 'set-codes', 'set-hours', 'set-reminders']);
  assert.ok(order.indexOf('set-backup') > order.indexOf('set-reminders'));
  assert.ok(order.indexOf('set-advanced') > order.indexOf('set-backup'));
  assert.equal(order.at(-1), 'set-about');
  // Avanzado plegado por defecto: nada de GitHub, token ni ntfy a la vista
  assert.equal(await page.evaluate(() => document.getElementById('set-advanced').open), false);
  assert.equal(await page.locator('input[aria-label="Token de GitHub"]').isVisible(), false);
  assert.equal(await page.locator('[data-fkey="ntfyEnabled"]').isVisible(), false);
  const visibleText = await page.evaluate(() => {
    const adv = document.getElementById('set-advanced');
    const clone = document.getElementById('view-ajustes').cloneNode(true);
    clone.querySelector('#set-advanced .advanced-body')?.remove();
    void adv;
    return clone.textContent;
  });
  assert.doesNotMatch(visibleText, /token|ntfy|GitHub|\.ics/i, 'sin jerga fuera de Opciones avanzadas');
  // Códigos: usados + F1/S1/N1/Z1; F2 (sin usar) solo en «Ver todos»
  assert.ok(await visible(page, '.code-row[data-code="F1"]'));
  assert.equal(await page.locator('.code-row[data-code="F2"]').count(), 0);
  await page.click('[data-testid="codes-all"]');
  assert.ok(await visible(page, '.code-row[data-code="F2"]'));
  assert.equal(await page.locator('.code-row[data-code="F2"].unconfirmed').count(), 0, 'F2 sin usar no se resalta');
  // Calendario sin configurar: «Tengo un enlace»
  assert.match(await text(page, '#set-calendar'), /Sin conectar/);
  assert.ok(await visible(page, '#set-calendar [data-testid="setup-paste-open"]'));
  await page.click('#set-advanced > summary');
  assert.equal(await page.evaluate(() => document.getElementById('set-advanced').open), true);
  assert.ok(await page.locator('input[aria-label="Token de GitHub"]').isVisible());
  return { ctx, errors };
});

test('opciones avanzadas: borrar todos los datos pide confirmar dos veces y se puede deshacer', async () => {
  const state = demoState();
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'ajustes');
  await page.click('#set-advanced > summary');
  await page.click('[data-testid="wipe"]');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-danger');
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Seguro?")');
  await page.click('.dialog-wrap.open .dialog .btn-danger');
  await page.waitForSelector('.toast .toast-action');
  let s = await getState(page);
  assert.equal(Object.keys(s.days).length, 0);
  assert.equal(s.settings.onboardingDone, true, 'no vuelve a salir la bienvenida');
  await page.click('.toast .toast-action'); // Deshacer
  await page.waitForFunction((k) => Object.keys(JSON.parse(localStorage.getItem(k)).days).length > 0, STORAGE_KEY);
  s = await getState(page);
  assert.equal(Object.keys(s.days).length, Object.keys(state.days).length);
  return { ctx, errors };
});

test('copia de seguridad: exportar, importar (con copia local) y «Deshacer»', async () => {
  const state = demoState();
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'ajustes');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-fkey="btn-export"]'),
  ]);
  const file = path.join(ROOT, 'test/e2e/out/backup-test.json');
  await download.saveAs(file);
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  assert.equal(json.app, 'turnos-mauricio');
  assert.equal(Object.keys(json.days).length, Object.keys(state.days).length);
  assert.ok(!/github_pat_/.test(raw), 'la copia no lleva el token');
  // Una copia más pequeña (3 días) reemplaza los datos… y se puede deshacer
  const small = core.createDefaultState();
  let s3 = small;
  for (const [k, c] of [['2026-10-20', ['F1']], ['2026-10-21', ['S1']], ['2026-10-22', ['N1']]]) s3 = core.setDay(s3, k, c, { now: new Date('2026-10-01T10:00:00Z') });
  const smallFile = path.join(ROOT, 'test/e2e/out/backup-small.json');
  fs.writeFileSync(smallFile, core.exportBackup(s3, { now: new Date('2026-10-01T10:00:00Z') }));
  await page.setInputFiles('input[data-testid="import-file"]', smallFile);
  await page.waitForSelector('.dialog-wrap.open');
  const dlg = await text(page, '.dialog-wrap.open .dialog');
  assert.match(dlg, /3 días con turnos/);
  assert.match(dlg, new RegExp(`este teléfono tiene ${Object.keys(state.days).length}`));
  await page.click('.dialog-wrap.open .dialog .btn-danger');
  await page.waitForSelector('.toast .toast-action');
  assert.equal(Object.keys((await getState(page)).days).length, 3);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('turnos-mauricio:before-import:')).length), 1, 'copia local antes de importar');
  await page.click('.toast .toast-action'); // Deshacer
  await page.waitForFunction((k) => Object.keys(JSON.parse(localStorage.getItem(k)).days).length > 3, STORAGE_KEY);
  assert.equal(Object.keys((await getState(page)).days).length, Object.keys(state.days).length);
  // Un archivo que no es una copia da un error amable
  const bad = path.join(ROOT, 'test/e2e/out/no-es-copia.json');
  fs.writeFileSync(bad, '{"hola": 1}');
  await page.setInputFiles('input[data-testid="import-file"]', bad);
  await page.waitForSelector('.toast-error');
  return { ctx, errors };
});

test('enlace #setup en Safari del iPhone (sin instalar): no configura nada y ofrece copiar el enlace', async () => {
  const gh = fakeGitHub();
  const hash = setupHash();
  const { page, ctx, errors, net } = await openApp({ state: demoState(), hash, standalone: false, gh });
  await page.waitForSelector('[data-testid="setup-safari"]');
  assert.match(await text(page, '.sheet'), /Copia este enlace y pégalo dentro de la app Turnos/);
  assert.equal(await page.evaluate(() => location.hash), '', 'la URL queda limpia (lleva el token)');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('[data-testid="setup-copy"]');
  await page.waitForFunction(() => /copiado/i.test(document.querySelector('[data-testid="setup-copy"]')?.textContent || ''));
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.endsWith(hash), 'copia el enlace completo');
  await page.waitForTimeout(2500);
  const s = await getState(page);
  assert.equal(s.settings.sync.enabled, false, 'no se configura en Safari');
  assert.equal(s.settings.sync.token, '');
  assert.deepEqual(net.github, [], 'ninguna petición a GitHub');
  return { ctx, errors };
});

test('enlace #setup en la app instalada: confirmar → comprobar → publicar → paso «Suscribirme en el iPhone»', async () => {
  const gh = fakeGitHub();
  const { page, ctx, errors } = await openApp({ state: demoState(), hash: setupHash(), gh });
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Mardar91\/mauricio-datos/);
  assert.equal(await page.evaluate(() => location.hash), '', 'la URL queda limpia');
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.body.dataset.tab), 'ajustes');
  assert.match(await text(page, '[data-testid="subscribe-step"] [data-testid="alerts-notice"]'), /Eliminar alertas/);
  await page.waitForSelector('.sheet-subscribe [data-testid="webcal"][aria-disabled="false"]');
  assert.equal(await page.getAttribute('.sheet-subscribe [data-testid="webcal"]', 'href'), `webcal://raw.githubusercontent.com/${OWNER}/${REPO}/HEAD/turnos.ics`);
  const s = await getState(page);
  assert.equal(s.settings.sync.enabled, true);
  assert.equal(s.settings.sync.token, TOKEN);
  assert.equal(s.settings.sync.key, KEY);
  assert.ok(s.settings.sync.deviceId, 'identidad guardada');
  const backup = gh.json('backup.json');
  assert.equal(backup.v, 3);
  assert.equal(backup.meta.publisher, s.settings.sync.deviceId, 'este dispositivo publica');
  assert.match(gh.text('turnos.ics'), /BEGIN:VCALENDAR/);
  assert.ok(gh.log.some((l) => /^GET \/repos\/[^ ]+\/contents\/turnos\.ics$/.test(l)), 'compara turnos.ics (GET sin ?ref con la rama por defecto) antes de escribirlo');
  assert.ok(!gh.text('backup.json').includes('github_pat_') && !gh.text('turnos.ics').includes('github_pat_'), 'el token no se publica');
  assert.ok(!gh.text('backup.json').includes('Llevar las llaves'), 'la copia va cifrada');
  // Cerrar el paso: en Ajustes el estado dice «Conectado»
  await page.click('.sheet-subscribe .sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.match(await text(page, '[data-testid="sync-status"]'), /Conectado/);
  await tab(page, 'hoy');
  assert.match(await text(page, '[data-testid="sync-line"]'), /Calendario del iPhone al día/);
  // Un cambio en un día se publica solo (en ~1,5 s)
  const writes = gh.writes().length;
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-20"]');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="F1"]');
  await page.click('[data-testid="day-save"]');
  await page.waitForFunction(() => true);
  const t0 = Date.now();
  while (gh.writes().length === writes && Date.now() - t0 < 6000) await page.waitForTimeout(200);
  assert.ok(gh.writes().length > writes, 'publica de nuevo tras un cambio');
  return { ctx, errors };
});

test('enlace con otra clave: si no descifra la copia, no cambia nada', async () => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'otro', key: KEY });
  const { page, ctx, errors } = await openApp({ state: demoState(), hash: setupHash({ key: core.generateSyncKey() }), gh });
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("No se pudo conectar")', { timeout: 15000 });
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /clave no coincide/);
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  const s = await getState(page);
  assert.equal(s.settings.sync.enabled, false, 'nada cambió');
  assert.equal(gh.writes().length, 2, 'solo las escrituras de la siembra');
  return { ctx, errors };
});

test('solo lectura: aviso en Ajustes y «Usar este dispositivo» pasa a publicar', async () => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'navegador' });
  const state = connected();
  const { page, ctx, errors } = await openApp({ state, gh });
  await waitState(page, (s) => s.settings.sync.publisher === 'navegador');
  assert.equal(gh.writes().length, 2, 'un dispositivo que solo lee no escribe');
  await tab(page, 'ajustes');
  await page.waitForSelector('[data-testid="sync-status"][data-kind="readonly"]');
  assert.match(await text(page, '[data-testid="sync-status"]'), /Este dispositivo solo lee[\s\S]*el calendario lo actualiza tu otra app/i);
  await page.click('[data-testid="takeover"]');
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Tu otra app dejará de hacerlo/);
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('.toast:has-text("ahora el calendario se actualiza desde aquí")', { timeout: 15000 });
  assert.equal(gh.json('backup.json').meta.publisher, 'iphone1');
  await page.waitForSelector('[data-testid="sync-status"][data-kind="ok"]');
  assert.equal(await page.locator('[data-testid="takeover"]').count(), 0);
  return { ctx, errors };
});

test('enlace de configuración pegado en Ajustes («Tengo un enlace») en la app instalada', async () => {
  const gh = fakeGitHub();
  const { page, ctx, errors } = await openApp({ state: demoState(), gh });
  await tab(page, 'ajustes');
  await page.click('[data-testid="setup-paste-open"]');
  await sheetOpen(page);
  assert.ok(await visible(page, '[data-testid="setup-paste-clip"]'), 'botón para pegar con un toque');
  await page.fill('[data-testid="setup-paste"]', 'esto no es un enlace');
  await page.click('[data-testid="setup-paste-go"]');
  assert.match(await text(page, '.sheet .form-error'), /no sirve/);
  // Pegar desde el portapapeles con un toque
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((t) => navigator.clipboard.writeText(t), `  ${APP}${setupHash()}\n`);
  await page.click('[data-testid="setup-paste-clip"]');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  assert.equal((await getState(page)).settings.sync.token, TOKEN);
  assert.ok(gh.writes('turnos.ics').length >= 1);
  return { ctx, errors };
});

test('primer uso con enlace #setup: primero el enlace y después la bienvenida', async () => {
  const { page, ctx, errors } = await openApp({ hash: setupHash() });
  await page.waitForSelector('.dialog-wrap.open');
  assert.equal(await page.locator('.onboarding').count(), 0);
  await page.click('.dialog-wrap.open .dialog .btn-secondary');
  await page.waitForSelector('.onboarding.open');
  return { ctx, errors };
});

test('enlace #setup no válido: aviso amable', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), hash: '#setup=no-vale' });
  await page.waitForSelector('.toast-error');
  assert.match(await text(page, '.toast-error'), /no es válido/);
  assert.equal(await page.evaluate(() => location.hash), '');
  return { ctx, errors };
});

test('calendario con error: Hoy lo dice sin jerga y Ajustes ofrece «Tengo un enlace nuevo»', async () => {
  const gh = fakeGitHub({ status: 401 });
  const { page, ctx, errors } = await openApp({ state: connected({ lastPushAt: '2026-10-10T08:00:00.000Z' }), gh });
  await waitState(page, (s) => s.settings.sync.lastErrorCode === 'AUTH');
  await page.waitForSelector('[data-testid="sync-line"].sync-alert');
  const line = await text(page, '[data-testid="sync-line"]');
  assert.match(line, /no se está actualizando/);
  assert.doesNotMatch(line, /token|GitHub|401/i);
  await page.click('[data-testid="sync-line"]');
  await page.waitForSelector('#view-ajustes:not([hidden])');
  assert.match(await text(page, '[data-testid="sync-status"]'), /no se está actualizando/);
  assert.ok(await visible(page, '#set-calendar [data-testid="setup-paste-open"]'));
  assert.match(await text(page, '#set-reminders'), /no se está actualizando/);
  return { ctx, errors };
});

test('ntfy (opciones avanzadas): activar genera un tema, programa avisos y envía la prueba', async () => {
  const { page, ctx, errors, net } = await openApp({ state: demoState() });
  await tab(page, 'ajustes');
  await page.click('#set-advanced > summary');
  await page.click('[data-fkey="ntfyEnabled"]');
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).settings.ntfy.topic, STORAGE_KEY);
  const topic = (await getState(page)).settings.ntfy.topic;
  assert.match(topic, /^turnos-mauricio-[a-z0-9]{12}$/);
  await page.waitForFunction((k) => Object.keys(JSON.parse(localStorage.getItem(k)).settings.ntfy.scheduled).length > 0, STORAGE_KEY, { timeout: 8000 });
  assert.ok(net.ntfy.some((l) => l.includes('"sequence_id":"2026-10-13-S1-pre"')), 'programa el aviso de hoy');
  await page.click('[data-fkey="btn-ntfyTest"]');
  await page.waitForSelector('.toast');
  assert.ok(net.ntfy.some((l) => l.includes('¡Funciona!')), 'envía la notificación de prueba');
  return { ctx, errors };
});

test('guardado fallido: aviso rojo fijo con «Exportar copia»', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith('turnos-mauricio')) throw new DOMException('lleno', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="F1"]');
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('[data-testid="banner-save"]');
  assert.match(await text(page, '[data-testid="banner-save"]'), /No se pudo guardar en este iPhone/);
  assert.match(await text(page, '.toast-error'), /No se pudo guardar/);
  await tab(page, 'hoy');
  assert.ok(await visible(page, '#view-hoy [data-testid="banner-save"] .banner-btn'));
  return { ctx, errors: errors.filter((e) => !/no se pudo guardar/i.test(e)) };
});

test('datos de una versión más nueva: aviso «Actualiza la app»', async () => {
  const st = demoState();
  st.schema = 99;
  const { page, ctx, errors } = await openApp({ state: st });
  assert.match(await text(page, '[data-testid="banner-newer"]'), /Actualiza la app/);
  return { ctx, errors };
});

test('horas: un mes a medias lo dice («Faltan N días del plan de este mes»)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'horas');
  // Noviembre no tiene plan; octubre completo; se crea un mes a medias en noviembre
  await page.evaluate(() => {
    const { store } = window.__turnosTest;
    store.set((s) => { s.days['2026-11-02'] = { codes: ['F1'], note: '', source: 'manual', updatedAt: '2026-10-12T10:00:00.000Z' }; return s; });
  });
  await page.click('#view-horas button[aria-label="Mes siguiente"]');
  assert.match(await text(page, '[data-testid="hours-partial"]'), /Faltan 29 días del plan de este mes/);
  assert.match(await text(page, '.hours-summary'), /hasta ahora/i);
  assert.equal(await page.locator('.hours-summary .hs-diff').count(), 0, 'sin diferencia engañosa');
  await page.click('#view-horas button[aria-label="Mes anterior"]');
  assert.equal(await page.locator('[data-testid="hours-partial"]').count(), 0);
  return { ctx, errors };
});

test('PWA: service worker, precache completo, versión y funcionamiento sin conexión', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), sw: 'allow' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const sw = fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8');
  const version = /const VERSION = '([^']+)'/.exec(sw)[1];
  const appVersion = /export const APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'docs/js/app.js'), 'utf8'))[1];
  assert.equal(version, appVersion, 'VERSION de sw.js y APP_VERSION de app.js deben coincidir');
  assert.match(sw, /const VENDOR = `turnos-vendor-\$\{VENDOR_VERSION\}`/, 'la caché de vendor/ lleva versión');
  const list = JSON.parse(`[${/const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
  // Todos los archivos de la app (salvo vendor) deben estar en el precache
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const docs = path.join(ROOT, 'docs');
  const appFiles = walk(docs).map((f) => path.relative(docs, f).split(path.sep).join('/'))
    .filter((f) => /^(js|css|icons)\//.test(f) || ['index.html', 'manifest.webmanifest'].includes(f));
  const missing = appFiles.filter((f) => !list.includes(f));
  assert.deepEqual(missing, [], `Faltan en PRECACHE de docs/sw.js: ${missing.join(', ')}`);
  for (const f of list.filter((x) => x !== './')) assert.ok(fs.existsSync(path.join(docs, f)), `no existe docs/${f}`);
  await page.waitForFunction((v) => caches.has(`turnos-shell-${v}`), version);
  const cached = await page.evaluate(async (v) => (await (await caches.open(`turnos-shell-${v}`)).keys()).length, version);
  assert.equal(cached, list.length);
  // Sin conexión
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.tabbar');
  assert.match(await text(page, '#view-hoy'), /Próximo turno/i);
  await ctx.setOffline(false);
  return { ctx, errors: errors.filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e)) };
});

test('PWA: nueva versión → aviso «Actualizar» → recarga con la caché nueva (y borra la de vendor vieja)', async () => {
  // Proxy delante del servidor estático para servir un sw.js con otra VERSION
  // (Playwright no intercepta la descarga del script del service worker)
  let swOverride = null;
  const proxy = http.createServer(async (req, res) => {
    if (swOverride && req.url.startsWith('/docs/sw.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(swOverride);
      return;
    }
    const r = await fetch(server.url + req.url);
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const ctx = await iphoneContext(browser, { scale: 1, sw: 'allow' });
    openContexts.push(ctx);
    const errors = [];
    const page = await preparePage(ctx, { state: demoState(), errors, standalone: true });
    await mockNetwork(page);
    await page.goto(`http://127.0.0.1:${proxy.address().port}/docs/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    assert.equal(await page.locator('.toast').count(), 0, 'sin aviso en la primera instalación');
    await page.evaluate(() => caches.open('turnos-vendor-viejo'));
    swOverride = fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8').replace(/const VERSION = '[^']+'/, "const VERSION = '9.9.9-test'");
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForSelector('.toast .toast-action', { timeout: 15000 });
    assert.match(await text(page, '.toast'), /nueva versión/);
    const nav = page.waitForEvent('framenavigated');
    await page.click('.toast-action');
    await nav;
    await page.waitForSelector('.tabbar');
    const keys = await page.evaluate(() => caches.keys());
    assert.ok(keys.includes('turnos-shell-9.9.9-test'));
    assert.ok(!keys.some((k) => k.startsWith('turnos-shell-') && k !== 'turnos-shell-9.9.9-test'), 'borra la caché anterior');
    assert.ok(!keys.includes('turnos-vendor-viejo'), 'borra la caché de vendor de otra versión');
    return { ctx, errors };
  } finally {
    proxy.close();
  }
});

test('PWA: manifest, iconos y metadatos de iOS', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  const m = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  assert.equal(m.name, 'Turnos de Mauricio');
  assert.equal(m.short_name, 'Turnos');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  const png = (f) => { const b = fs.readFileSync(path.join(ROOT, 'docs', f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  for (const i of m.icons.filter((x) => x.type === 'image/png')) {
    const [w, h] = png(i.src);
    assert.equal(`${w}x${h}`, i.sizes, i.src);
  }
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  assert.deepEqual(png('icons/apple-touch-icon.png'), [180, 180]);
  for (const sel of ['link[rel="apple-touch-icon"]', 'meta[name="apple-mobile-web-app-capable"]', 'meta[name="apple-mobile-web-app-title"]', 'meta[name="apple-mobile-web-app-status-bar-style"]']) {
    assert.equal(await page.locator(sel).count(), 1, sel);
  }
  assert.match(await page.getAttribute('meta[name="viewport"]', 'content'), /viewport-fit=cover/);
  return { ctx, errors };
});

test('diseño: nada se sale de la pantalla a 360 px', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState({ sync: true, ntfy: true }), width: 360 });
  const problems = [];
  for (const id of ['hoy', 'calendario', 'escanear', 'horas', 'ajustes']) {
    await tab(page, id);
    await page.waitForTimeout(150);
    problems.push(...(await findOverflow(page)).map((p) => `${id}: ${p}`));
  }
  await page.click('#set-advanced > summary');
  await page.waitForTimeout(150);
  problems.push(...(await findOverflow(page)).map((p) => `avanzado: ${p}`));
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-26"]');
  await sheetOpen(page);
  problems.push(...(await findOverflow(page)).map((p) => `editar día: ${p}`));
  await page.click('.sheet .tile[data-code="S1"]');
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.toast.show .toast-action');
  await page.waitForTimeout(350);
  problems.push(...(await findOverflow(page)).map((p) => `aviso: ${p}`));
  assert.deepEqual(problems, []);
  return { ctx, errors };
});

test('diseño: objetivos táctiles de al menos 44 px y campos de 16 px o más (sin zoom en iOS)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState({ sync: true, ntfy: true }) });
  const small = [];
  const check = async (where) => {
    small.push(...(await page.evaluate((w) => {
      const out = [];
      for (const el of document.querySelectorAll('button, a.btn, label.btn, .switch, .check, input, select, textarea')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest('[hidden], .file-inputs, .visually-hidden') || getComputedStyle(el).visibility === 'hidden') continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && el.type !== 'checkbox' && fs < 16) out.push(`${w}: campo ${el.getAttribute('aria-label') || el.className} ${fs}px`);
        // Interruptores y círculos: la fila entera (label) es el objetivo
        if (el.matches('.switch, .check')) { const lab = el.closest('label'); if (lab) { const lr = lab.getBoundingClientRect(); if (lr.height >= 44) continue; } }
        if (el.matches('.link-inline')) continue; // enlace dentro de una tarjeta que también se puede tocar
        if (Math.min(r.height, r.width) < 43.5) out.push(`${w}: ${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} ${Math.round(r.width)}×${Math.round(r.height)} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}"`);
      }
      return out;
    }, where)));
  };
  for (const id of ['hoy', 'calendario', 'escanear', 'horas', 'ajustes']) { await tab(page, id); await page.waitForTimeout(120); await check(id); }
  await page.click('#set-advanced > summary');
  await check('avanzado');
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-26"]');
  await sheetOpen(page);
  await check('editar día');
  assert.deepEqual([...new Set(small)], []);
  return { ctx, errors };
});

test('accesibilidad básica: botones con nombre e imágenes con alt', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  for (const id of ['hoy', 'calendario', 'escanear', 'horas', 'ajustes']) {
    await tab(page, id);
    const bad = await page.evaluate(() => [...document.querySelectorAll('.view:not([hidden]) button, .tabbar button')]
      .filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim()))
      .map((b) => b.outerHTML.slice(0, 80)));
    assert.deepEqual(bad, [], `botones sin nombre en ${id}`);
    const imgs = await page.evaluate(() => [...document.querySelectorAll('.view:not([hidden]) img')].filter((i) => !i.hasAttribute('alt')).length);
    assert.equal(imgs, 0);
  }
  return { ctx, errors };
});

test('textos: español neutro (sin giros solo de España ni «X» para miércoles)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  const all = [];
  for (const id of ['hoy', 'calendario', 'escanear', 'horas', 'ajustes']) {
    await tab(page, id);
    all.push(await page.evaluate(() => document.querySelector('.view:not([hidden])').textContent));
  }
  const src = fs.readdirSync(path.join(ROOT, 'docs/js/ui')).map((f) => fs.readFileSync(path.join(ROOT, 'docs/js/ui', f), 'utf8')).join('\n');
  for (const re of [/Hacer foto/, /Haz una foto/, /hazle una foto/i, /Rellen/, /He podido/, /ha fallado/, /de baja\b/, /Acuéstate pronto/, /[«"]X[»"]/]) {
    assert.doesNotMatch(src, re, `texto a cambiar: ${re}`);
  }
  assert.doesNotMatch(all.join(' '), /\bX\b/);
  return { ctx, errors };
});

// ---------------------------------------------------------------------------

let pass = 0, fail = 0;
const failures = [];
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  const t0 = Date.now();
  try {
    const res = await t.fn();
    const errs = res?.errors || [];
    assert.deepEqual(errs, [], 'errores en la consola o en la página');
    pass++;
    console.log(`  ✔ ${t.name} (${Date.now() - t0} ms)`);
  } catch (e) {
    fail++;
    failures.push(t.name);
    console.log(`  ✘ ${t.name}\n      ${String(e.message).split('\n').slice(0, 8).join('\n      ')}`);
  } finally {
    for (const c of openContexts.splice(0)) await c.close().catch(() => {});
  }
}
await browser.close();
await server.close();
console.log(`\n${pass} correctos, ${fail} fallidos`);
if (fail) {
  console.log('Fallidos:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exitCode = 1;
}
