// Tests de interfaz con Playwright (Chromium, pantalla tipo iPhone). Uso: npm run e2e [-- filtro]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/serve.mjs';
import {
  KEY, NOW, OTHER_KEY, OWNER, REPO, ROOT, STORAGE_KEY, SYNC, TOKEN, core, demoState, ensureOut, fakeGitHub, findOverflow,
  iphoneContext, mockNetwork, preparePage, seedRemote,
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
// device: 'android' | 'desktop' | 'ipad' (por defecto, iPhone)
async function openApp({ state = null, sw = 'block', width = 390, height = 844, hash = '', net = true, standalone = true, ios = true, gh, device } = {}) {
  const ctx = await iphoneContext(browser, { scale: 1, sw, width, height, ios, device });
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
// Suma (en minutos) de las líneas de «Saldo de horas» («+18 h 30», «−2 h 30», «+5 h»)
const sumBalanceRows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="overtime"] .bal-months b')]
  .map((b) => { const m = b.textContent.trim().match(/^([+−-]?)(\d+) h(?: (\d+))?$/); return m ? (m[1] === '+' || !m[1] ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : NaN; })
  .reduce((a, n) => a + n, 0));
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
  assert.equal(await text(page, '.ob-title'), '¡Hola! 👋', 'sin nombre todavía: saludo neutro');
  await page.click('.ob-skip');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  assert.match(await text(page, '#view-hoy'), /Aún no tienes turnos/);
  assert.equal(await text(page, '#view-hoy .large-title'), 'Hola 👋');
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
  assert.equal(steps, 4, 'en iPhone (Safari) se muestra el paso de instalar (bienvenida, nombre, instalar, avisos)');
  await page.click('.ob-bottom .btn-primary');
  await page.click('.ob-bottom .btn-primary'); // nombre: se puede dejar vacío
  const install = await text(page, '.ob-step');
  assert.match(install, /«•••»\s*\(abajo a la derecha\) y luego «Compartir»/);
  assert.match(install, /iOS más antiguo, Compartir está abajo en el centro/);
  assert.match(install, /Agregar a inicio/);
  assert.match(install, /Añadir a pantalla de inicio/);
  assert.match(install, /Deja activado «Abrir como app web»/);
  for (let i = 2; i < steps; i++) await page.click('.ob-bottom .btn-primary');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  assert.ok(await visible(page, '#view-hoy'), 'en Safari no lleva a escanear');
  assert.match(await text(page, '[data-testid="banner-safari"]'), /Instala la app para no perder tus datos/);
  // Hoy vacío en Safari: lo primero es instalar (escanear aquí queda en segundo plano)
  assert.match(await text(page, '#view-hoy .empty .btn-primary'), /Instalar la app/);
  assert.ok(await visible(page, '[data-testid="empty-scan-here"]'));
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
  assert.equal(await page.locator('.ob-dot').count(), 3, 'sin paso de instalar');
  for (let i = 0; i < 3; i++) await page.click('.ob-bottom .btn-primary');
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
  assert.match(await text(page, '.de-time[data-code="F1"]'), /06:00–15:00[\s\S]*8 h 30 de trabajo/);
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
  assert.match(await text(page, '.review-head'), /Toca cada día y elige su turno\. Al final, toca «Guardar»/, 'sin días guardados no habla de «lo que ya tienes»');
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
  // F6 solo se usó en junio: está en «Ver todos los códigos»
  assert.equal(await page.locator('.code-row[data-code="F6"]').count(), 0);
  await page.click('[data-testid="codes-all"]');
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

test('opciones avanzadas: borrar todos los datos pide confirmar dos veces y «Deshacer» lo deja todo como antes', async () => {
  const state = demoState({ sync: true, ntfy: true });
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'ajustes');
  await page.click('#set-advanced > summary');
  await page.click('[data-testid="wipe"]');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-danger');
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Lo confirmas?")');
  await page.click('.dialog-wrap.open .dialog .btn-danger');
  await page.waitForSelector('.toast .toast-action');
  let s = await getState(page);
  assert.equal(Object.keys(s.days).length, 0);
  assert.equal(s.settings.onboardingDone, true, 'no vuelve a salir la bienvenida');
  assert.equal(s.settings.sync.enabled, false, 'también la conexión del calendario');
  await page.click('.toast .toast-action'); // Deshacer
  await page.waitForFunction((k) => Object.keys(JSON.parse(localStorage.getItem(k)).days).length > 0, STORAGE_KEY);
  s = await getState(page);
  assert.equal(Object.keys(s.days).length, Object.keys(state.days).length);
  // «Todo como antes» de verdad: el calendario sigue conectado (misma identidad) y ntfy activado
  assert.equal(s.settings.sync.enabled, true);
  assert.equal(s.settings.sync.token, TOKEN);
  assert.equal(s.settings.sync.key, KEY);
  assert.equal(s.settings.sync.deviceId, 'iphone1');
  assert.equal(s.settings.ntfy.enabled, true);
  assert.equal(s.settings.ntfy.topic, state.settings.ntfy.topic);
  await page.waitForSelector('[data-testid="sync-status"]:not([data-kind="off"])');
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
  assert.match(dlg, new RegExp(`este teléfono tiene ${Object.keys(state.days).length} días`));
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
  const confirmText = await text(page, '.dialog-wrap.open .dialog');
  assert.match(confirmText, /lo preparó quien te ayuda/);
  assert.doesNotMatch(confirmText, /Mardar91|mauricio-datos/, 'sin datos técnicos en la confirmación');
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
  assert.match(await page.locator('.dialog-wrap.open .dialog', { has: page.locator('.dialog-title:text("No se pudo conectar")') }).innerText(), /clave no coincide/);
  assert.equal(await page.locator('.dialog-wrap.open').count(), 1, 'el «Conectando…» no se queda abierto debajo');
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
  assert.match(await text(page, '[data-testid="sync-status"]'), /Este dispositivo solo lee[\s\S]*otro dispositivo \(por ejemplo, el de quien te ayuda\)/i);
  assert.doesNotMatch(await text(page, '#set-calendar'), /tu otra app/i);
  await page.click('[data-testid="takeover"]');
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /otro dispositivo \(por ejemplo, el de quien te ayuda\), que dejará de hacerlo/);
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

test('flujo del README: el ordenador de quien ayuda crea el enlace y el iPhone de Mauricio pasa a publicar', async () => {
  const gh = fakeGitHub({ empty: true });
  // 1) Ordenador de quien ayuda: sin datos, navegador normal (no iOS)
  const helperState = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  const A = await openApp({ state: helperState, ios: false, standalone: false, gh });
  await tab(A.page, 'ajustes');
  await A.page.click('[data-testid="advanced"] > summary');
  await A.page.fill('[data-fkey="gh-owner"]', OWNER);
  await A.page.fill('[data-fkey="gh-repo"]', REPO);
  await A.page.fill('[data-fkey="gh-token"]', TOKEN);
  await A.page.click('[data-fkey="btn-connect"]');
  await waitState(A.page, (s) => Boolean(s.settings.sync.enabled && s.settings.sync.lastPushAt), null, 15000);
  const sA = (await getState(A.page)).settings.sync;
  assert.equal(sA.publisher, sA.deviceId, 'el ordenador vacío publica primero (repo vacío)');
  // Quien ayuda no ve el paso «Suscribirme»: le lleva a «Crear enlace…» (y a «para otra persona»)
  await A.page.waitForSelector('.dialog-wrap.open .dialog-title:text("Conectado")');
  assert.match(await text(A.page, '.dialog-wrap.open .dialog'), /Crear enlace de configuración[\s\S]*Crear enlace para otra persona/);
  await A.page.click('.dialog-wrap.open .dialog .btn-primary');
  await A.page.waitForSelector('.dialog-wrap.open', { state: 'detached' });
  assert.equal(await A.page.locator('.sheet-subscribe').count(), 0, 'sin paso «Suscribirme» en el dispositivo de quien ayuda');
  assert.ok(await A.page.locator('[data-testid="make-link"]').isVisible(), '«Crear enlace» a la vista');
  await A.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await A.page.click('[data-testid="make-link"]');
  await A.page.waitForSelector('.toast:has-text("Enlace copiado")');
  const link = await A.page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#setup=/);
  // 2) iPhone de Mauricio: app instalada con sus turnos; pega el enlace
  const B = await openApp({ state: demoState(), gh });
  await tab(B.page, 'ajustes');
  await B.page.click('[data-testid="setup-paste-open"]');
  await sheetOpen(B.page);
  await B.page.fill('[data-testid="setup-paste"]', link);
  await B.page.click('[data-testid="setup-paste-go"]');
  await B.page.waitForSelector('.dialog-wrap.open');
  await B.page.click('.dialog-wrap.open .dialog .btn-primary');
  // Otro dispositivo publica → pregunta si este iPhone toma el relevo
  await B.page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Usar este iPhone para actualizar el calendario?")', { timeout: 15000 });
  await B.page.click('.dialog-wrap.open .dialog .btn-primary');
  await B.page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  const sB = (await getState(B.page)).settings.sync;
  assert.equal(gh.json('backup.json').meta.publisher, sB.deviceId, 'el iPhone publica');
  const ics = gh.text('turnos.ics');
  assert.match(ics, /DTSTART;TZID=Europe\/Berlin:20261013T133000/, 'el calendario tiene los turnos del iPhone');
  assert.equal(sB.key, sA.key, 'misma clave en los dos dispositivos');
  return { ctx: B.ctx, errors: [...A.errors, ...B.errors] };
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
  // La línea ya lo dice: el consejo igual no se repite en Hoy (sí en Horas)
  const titles = await page.locator('#view-hoy .advice-title').allInnerTexts();
  assert.ok(!titles.some((t) => /no se está actualizando/.test(t)), `sin aviso repetido en Hoy: ${titles.join(' | ')}`);
  await page.click('[data-testid="sync-line"]');
  await page.waitForSelector('#view-ajustes:not([hidden])');
  assert.match(await text(page, '[data-testid="sync-status"]'), /no se está actualizando/);
  assert.ok(await visible(page, '#set-calendar [data-testid="setup-paste-open"]'));
  assert.match(await page.getAttribute('#set-calendar [data-testid="setup-paste-open"]', 'class'), /btn-primary/);
  assert.match(await page.getAttribute('#set-calendar [data-testid="webcal"]', 'class'), /btn-secondary/, 'suscribirse queda en segundo plano');
  assert.equal(await page.locator('#set-calendar [data-testid="alerts-notice"]').count(), 0);
  assert.match(await text(page, '#set-reminders'), /no se está actualizando/);
  await tab(page, 'horas');
  assert.match(await text(page, '#hours-advice'), /Tu calendario no se está actualizando/);
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
  assert.equal(await text(page, '.toast-error .toast-action'), 'Exportar copia', 'el aviso lleva «Exportar copia» (el rojo de arriba puede no verse)');
  await tab(page, 'hoy');
  assert.ok(await visible(page, '#view-hoy [data-testid="banner-save"] .banner-btn'));
  // Guardar un código tampoco dice «guardado» si no se guardó
  await page.evaluate(() => { for (const t of document.querySelectorAll('.toast')) t.remove(); });
  await tab(page, 'ajustes');
  await page.click('.code-row[data-code="Z1"]');
  await sheetOpen(page);
  await page.fill('.sheet-code input[type="time"] >> nth=0', '09:00');
  await page.click('[data-testid="code-save"]');
  if (await page.locator('.dialog-wrap.open').count()) await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('.toast-error');
  assert.equal(await page.locator('.toast-ok').count(), 0, 'sin «✅ Z1 guardado»');
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
  // Calendario: lo mismo (diferencia «—» con el mes a medias)
  await tab(page, 'calendario');
  assert.notEqual((await text(page, '[data-testid="month-diff"]')).split('\n').pop().trim(), '—', 'octubre completo: con diferencia');
  await page.click('#view-calendario button[aria-label="Mes siguiente"]');
  assert.match(await text(page, '[data-testid="month-diff"]'), /—/);
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
  assert.equal(m.name, 'Turnos', 'nombre neutro (lo usan varias personas)');
  assert.equal(await page.title(), 'Turnos');
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
      for (const el of document.querySelectorAll('button, a.btn, a.link-btn, label.btn, .switch, .check, input, select, textarea, summary')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest('[hidden], .file-inputs, .visually-hidden') || getComputedStyle(el).visibility === 'hidden') continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && el.type !== 'checkbox' && fs < 16) out.push(`${w}: campo ${el.getAttribute('aria-label') || el.className} ${fs}px`);
        // Interruptores y círculos: la fila entera (label) es el objetivo
        if (el.matches('.switch, .check')) { const lab = el.closest('label'); if (lab) { const lr = lab.getBoundingClientRect(); if (lr.height >= 44) continue; } }
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
  for (const re of [/Hacer foto/, /Haz una foto/, /hazle una foto/i, /Rellen/, /He podido/, /ha fallado/, /de baja\b/, /Acuéstate pronto/, /[«"]X[»"]/,
    // Lo usan Mauricio y su hermana: sin textos con género
    /¿Seguro\b/, /\bestás suscrit[oa]\b/, /\bbienvenido\b/i]) {
    assert.doesNotMatch(src, re, `texto a cambiar: ${re}`);
  }
  assert.doesNotMatch(all.join(' '), /\bX\b/);
  return { ctx, errors };
});

test('horario especial: cambiar la hora solo un día (horas, calendario, Hoy y .ics) y volver al normal', async () => {
  const gh = fakeGitHub();
  const state = demoState({ sync: true });
  const day = '2026-10-13';
  const otherS1 = Object.keys(state.days).sort().find((k) => k > day && state.days[k].codes.includes('S1'));
  assert.ok(otherS1, 'hay otro día con S1');
  const { page, ctx, errors } = await openApp({ state, gh });
  // Primero se publica el calendario normal
  const t0 = Date.now();
  while (!gh.text('turnos.ics') && Date.now() - t0 < 8000) await page.waitForTimeout(150);
  assert.match(gh.text('turnos.ics'), /DTSTART;TZID=Europe\/Berlin:20261013T133000/);
  const weekBefore = core.weekSummary(state, '2026-10-12').total;
  await tab(page, 'calendario');
  await page.click(`.day-row[data-key="${day}"]`);
  await sheetOpen(page);
  const card = `.de-time[data-code="S1"]`;
  assert.match(await text(page, card), /13:30–22:00[\s\S]*8 h de trabajo/);
  assert.doesNotMatch(await text(page, '.sheet-day'), /\bnull\b|undefined/);
  assert.match(await text(page, `${card} [data-testid="code-all-days"]`), /Cambiar el horario de S1 en todos los días/);
  await page.click(`${card} [data-testid="day-time-edit"]`);
  await page.fill(`${card} [data-testid="day-time-start"]`, '15:00');
  await page.fill(`${card} [data-testid="day-time-end"]`, '20:00');
  assert.equal(await page.inputValue(`${card} [data-testid="day-time-break"]`), '0', 'un día de 5 h no lleva la pausa de 30 min');
  assert.match(await text(page, card), /15:00–20:00[\s\S]*horario especial[\s\S]*5 h de trabajo/);
  assert.match(await text(page, card), /Los demás días, S1 sigue 13:30–22:00/);
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  let s = await getState(page);
  assert.deepEqual(s.days[day].times, { S1: { start: '15:00', end: '20:00', breakMin: 0 } });
  assert.equal(s.codes.S1?.start ?? core.DEFAULT_CODES.S1.start, '13:30', 'S1 no cambia en los demás días');
  // Calendario: ese día con su hora y la marca; otro S1, igual que siempre
  assert.match(await text(page, `.day-row[data-key="${day}"]`), /15:00–20:00/);
  assert.equal(await page.locator(`.day-row[data-key="${day}"] [data-testid="special-mark"]`).count(), 1);
  assert.match(await page.getAttribute(`.day-row[data-key="${day}"]`, 'aria-label'), /horario especial/);
  await page.click('button[aria-label="Mes siguiente"]');
  await page.click('button[aria-label="Mes anterior"]');
  if (otherS1.slice(0, 7) === day.slice(0, 7)) {
    assert.match(await text(page, `.day-row[data-key="${otherS1}"]`), /13:30–22:00/);
    assert.equal(await page.locator(`.day-row[data-key="${otherS1}"] [data-testid="special-mark"]`).count(), 0);
  }
  assert.match(await text(page, '.week[data-week="2026-10-12"] .week-sep-hours'), new RegExp(core.formatHours(weekBefore - 480 + 300)));
  // Hoy: la tarjeta grande usa la hora de ese día
  await tab(page, 'hoy');
  const hero = await text(page, '.hero');
  assert.match(hero, /15:00 – 20:00/);
  assert.match(hero, /horario especial/);
  assert.match(hero, /empieza en 4 h 45 min/);
  assert.match(hero, /5 h de trabajo/);
  // El .ics publicado: solo cambia el evento de ese día
  const t1 = Date.now();
  while (!/20261013T150000/.test(gh.text('turnos.ics')) && Date.now() - t1 < 8000) await page.waitForTimeout(150);
  const ics = gh.text('turnos.ics').replace(/\r\n /g, '');
  const ev = (uid) => ics.split('BEGIN:VEVENT').find((b) => b.includes(`UID:${uid}@turnos-mauricio`)) || '';
  assert.match(ev(`${day}-S1`), /DTSTART;TZID=Europe\/Berlin:20261013T150000/);
  assert.match(ev(`${day}-S1`), /DTEND;TZID=Europe\/Berlin:20261013T200000/);
  const o = otherS1.replace(/-/g, '');
  assert.match(ev(`${otherS1}-S1`), new RegExp(`DTSTART;TZID=Europe/Berlin:${o}T133000`));
  // Volver al horario normal
  await tab(page, 'calendario');
  await page.click(`.day-row[data-key="${day}"]`);
  await sheetOpen(page);
  assert.match(await text(page, card), /horario especial/);
  await page.click(`${card} [data-testid="day-time-reset"]`);
  assert.match(await text(page, card), /13:30–22:00/);
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  s = await getState(page);
  assert.ok(!s.days[day].times || !s.days[day].times.S1, 'sin horario especial');
  assert.match(await text(page, `.day-row[data-key="${day}"]`), /13:30–22:00/);
  assert.equal(await page.locator(`.day-row[data-key="${day}"] [data-testid="special-mark"]`).count(), 0);
  return { ctx, errors };
});

test('horario especial: quitar el código quita su hora; una hora incompleta no se guarda', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-13"]');
  await sheetOpen(page);
  await page.click('.de-time[data-code="S1"] [data-testid="day-time-edit"]');
  await page.fill('.de-time[data-code="S1"] [data-testid="day-time-end"]', '');
  await page.click('[data-testid="day-save"]');
  assert.match(await text(page, '.sheet-day .form-error'), /Pon la hora de inicio y la de fin de S1/);
  await page.fill('.de-time[data-code="S1"] [data-testid="day-time-end"]', '23:00');
  // Cambiar S1 por F1: la hora especial de S1 se va con él
  await page.click('.sheet .tile[data-code="F1"]');
  assert.equal(await page.locator('.de-time[data-code="S1"]').count(), 0);
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  const s = await getState(page);
  assert.deepEqual(s.days['2026-10-13'].codes, ['F1', 'S51']);
  assert.ok(!s.days['2026-10-13'].times, 'sin horarios de códigos que ya no están');
  return { ctx, errors };
});

test('códigos: «Cambiar el horario de S1 en todos los días» avisa con el número de días y pide confirmar', async () => {
  const state = demoState();
  const { page, ctx, errors } = await openApp({ state });
  const all = Object.values(state.days).filter((d) => d.codes.includes('S1')).length;
  const future = Object.entries(state.days).filter(([k, d]) => k >= '2026-10-13' && d.codes.includes('S1')).length;
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-13"]');
  await sheetOpen(page);
  await page.click('.de-time[data-code="S1"] [data-testid="code-all-days"]');
  await page.waitForSelector('.sheet-code');
  await page.waitForTimeout(400);
  const notice = await text(page, '[data-testid="code-all-days-notice"]');
  assert.match(notice, new RegExp(`Esto cambia S1 en todos tus días \\(${all} días\\)`));
  assert.match(notice, /Si solo cambia hoy, usa «Cambiar la hora solo este día»/);
  await page.fill('.sheet-code input[type="time"] >> nth=0', '14:00');
  await page.click('[data-testid="code-save"]');
  await page.waitForSelector('.dialog-wrap.open');
  const dlg = await text(page, '.dialog-wrap.open .dialog');
  assert.match(dlg, /¿Cambiar S1 en todos los días\?/);
  assert.match(dlg, new RegExp(`S1 pasará a 14:00–22:00 en ${future} días de tu plan, desde hoy`));
  await page.click('.dialog-wrap.open .dialog .btn-secondary'); // No
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  assert.equal((await getState(page)).codes.S1?.start ?? '13:30', '13:30', 'no cambió nada');
  await page.click('[data-testid="code-save"]');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('.sheet-code', { state: 'detached' });
  assert.equal((await getState(page)).codes.S1.start, '14:00');
  assert.match(await text(page, '.de-time[data-code="S1"]'), /14:00–22:00/, 'el editor del día se actualiza');
  return { ctx, errors };
});

test('Hoy: un código con solo hora de inicio no muestra «null»', async () => {
  let state = demoState();
  state = core.upsertCode(state, { ...core.getCode(state, 'TS'), start: '10:45', end: null, countsHours: true });
  state = core.setDay(state, '2026-10-13', ['TS']);
  const { page, ctx, errors } = await openApp({ state });
  const hero = await text(page, '.hero');
  assert.doesNotMatch(hero, /null/);
  assert.match(hero, /desde las 10:45/);
  assert.doesNotMatch(await page.getAttribute('[data-testid="hero-open"]', 'aria-label'), /null/);
  return { ctx, errors };
});

test('calendario: suscribirse se recuerda («Suscrito ✓») y un enlace renovado no vuelve a pedirlo', async () => {
  const gh = fakeGitHub();
  const { page, ctx, errors } = await openApp({ state: demoState({ sync: true }), gh });
  // Que el enlace webcal no navegue en Chromium
  await page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest?.('a[href^="webcal:"]')) e.preventDefault(); }));
  await tab(page, 'ajustes');
  assert.ok(await visible(page, '#set-calendar [data-testid="webcal"]'));
  assert.equal(await page.locator('[data-testid="subscribed"]').count(), 0);
  // Enlace nuevo con la misma dirección en un teléfono que ya funcionaba: no se repite «Último paso»
  await page.click('[data-testid="setup-paste-renew"]');
  await sheetOpen(page);
  await page.fill('[data-testid="setup-paste"]', `${APP}${setupHash()}`);
  await page.click('[data-testid="setup-paste-go"]');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('.toast:has-text("sigue funcionando")', { timeout: 15000 });
  assert.equal(await page.locator('.sheet-subscribe').count(), 0, 'sin «Último paso» otra vez');
  // Tocar «Suscribirme en el iPhone» se recuerda en este dispositivo
  await page.click('#set-calendar [data-testid="webcal"]');
  await page.waitForSelector('#set-calendar [data-testid="subscribed"]');
  const sub = await page.evaluate(() => JSON.parse(localStorage.getItem('turnos-mauricio:subscribed')));
  assert.equal(sub.url, `webcal://raw.githubusercontent.com/${OWNER}/${REPO}/HEAD/turnos.ics`);
  assert.match(await text(page, '[data-testid="subscribed"]'), /Suscrito ✓/);
  assert.equal(await page.locator('#set-calendar [data-testid="webcal"]').count(), 0, 'sin el botón grande');
  assert.equal(await page.locator('#set-calendar [data-testid="alerts-notice"]').count(), 0);
  // «Suscribirme otra vez» avisa de que se duplicaría
  await page.click('[data-testid="subscribe-again"]');
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /verías cada turno \(y cada aviso\) dos veces/);
  await page.click('.dialog-wrap.open .dialog .btn-secondary');
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  return { ctx, errors };
});

test('enlace #setup: el paso «Suscribirme» no invita a repetirlo, avisa sin internet y recuerda la suscripción', async () => {
  const gh = fakeGitHub();
  const { page, ctx, errors } = await openApp({ state: demoState(), hash: setupHash(), gh });
  await page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest?.('a[href^="webcal:"]')) e.preventDefault(); }));
  // Sin internet al conectar
  const offline = (r) => r.abort('internetdisconnected');
  await page.route('https://api.github.com/**', offline);
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  const sheetText = await text(page, '.sheet-subscribe');
  assert.doesNotMatch(sheetText, /repetir cuando quieras/i);
  assert.match(sheetText, /Hazlo una sola vez/);
  assert.doesNotMatch(sheetText, /\bnull\b|undefined/);
  assert.equal(await page.getAttribute('.sheet-subscribe [data-testid="webcal"]', 'aria-disabled'), 'true');
  assert.match(await text(page, '.sheet-subscribe [data-testid="offline-hint"]'), /Sin conexión a internet: el botón se activará solo cuando vuelva/);
  // Vuelve internet: el botón se activa y tocarlo se recuerda
  await page.unroute('https://api.github.com/**', offline);
  await page.evaluate(() => window.__turnosTest.background().syncNow());
  await page.waitForSelector('.sheet-subscribe [data-testid="webcal"][aria-disabled="false"]', { timeout: 15000 });
  assert.equal(await page.locator('.sheet-subscribe [data-testid="offline-hint"]').count(), 0);
  await page.click('.sheet-subscribe [data-testid="webcal"]');
  await page.waitForSelector('.sheet-subscribe [data-testid="subscribe-done"]');
  await page.click('[data-testid="subscribe-close"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.ok(await visible(page, '#set-calendar [data-testid="subscribed"]'));
  return { ctx, errors };
});

test('enlace #setup sin internet: al volver la conexión, si otro dispositivo publica, pregunta «¿Usar este iPhone?»', async () => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'navegador' });
  const { page, ctx, errors } = await openApp({ state: demoState(), hash: setupHash(), gh });
  const offline = (r) => r.abort('internetdisconnected');
  await page.route('https://api.github.com/**', offline);
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await page.click('.sheet-subscribe .sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.unroute('https://api.github.com/**', offline);
  await page.evaluate(() => window.__turnosTest.background().syncNow());
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Usar este iPhone para actualizar el calendario?")', { timeout: 15000 });
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Recomendado si este es tu iPhone/);
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('.toast:has-text("ahora el calendario se actualiza desde aquí")', { timeout: 15000 });
  assert.equal(gh.json('backup.json').meta.publisher, (await getState(page)).settings.sync.deviceId);
  assert.equal(await page.evaluate(() => localStorage.getItem('turnos-mauricio:ask-takeover')), null, 'solo se pregunta una vez');
  return { ctx, errors };
});

test('enlace #setup en Safari con almacenamiento nuevo: la bienvenida no tapa «Copia este enlace»', async () => {
  const { page, ctx, errors, net } = await openApp({ state: null, hash: setupHash(), standalone: false });
  await page.waitForSelector('[data-testid="setup-safari"]');
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.onboarding').count(), 0, 'sin bienvenida encima');
  const onTop = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="setup-copy"]').getBoundingClientRect();
    return Boolean(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[data-testid="setup-copy"]'));
  });
  assert.ok(onTop, 'el botón «Copiar el enlace» se puede tocar');
  assert.deepEqual(net.github, []);
  return { ctx, errors };
});

test('Ajustes en Safari (sin instalar): primero «Instalar la app», con la guía de iOS 26', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), standalone: false });
  await tab(page, 'ajustes');
  assert.equal(await page.locator('#set-calendar [data-testid="setup-paste-open"]').count(), 0, 'pegar el enlace aquí no sirve');
  assert.match(await text(page, '#set-calendar'), /se pega dentro de la app, no aquí en Safari/);
  await page.click('[data-testid="cal-install"]');
  await sheetOpen(page);
  const guide = await text(page, '.sheet-install');
  assert.match(guide, /Toca «•••»\s*\(abajo a la derecha\) y luego «Compartir»/);
  assert.match(guide, /Deja activado «Abrir como app web»/);
  assert.equal(await page.locator('.sheet-install .ios-more').count(), 1);
  assert.equal(await page.locator('.sheet-install .ios-toggle').count(), 1);
  return { ctx, errors };
});

test('calendario con datos de una versión más nueva: «Actualizar la app» (no «Tengo un enlace nuevo»)', async () => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'iphone1' });
  const doc = gh.json('backup.json');
  doc.v = 9;
  gh.write('backup.json', JSON.stringify(doc));
  const { page, ctx, errors } = await openApp({ state: connected(), gh });
  await waitState(page, (s) => s.settings.sync.lastErrorCode === 'NEWER_REMOTE');
  await page.waitForSelector('[data-testid="sync-line"].sync-alert');
  assert.match(await text(page, '[data-testid="sync-line"]'), /Actualiza la app/);
  await tab(page, 'ajustes');
  assert.match(await text(page, '#set-calendar [data-testid="update-app"]'), /Actualizar la app/);
  assert.equal(await page.locator('#set-calendar [data-testid="setup-paste-open"]').count(), 0);
  return { ctx, errors };
});

test('Ajustes: «Mis turnos y horarios» corto (lugares plegados, turnos de los próximos 2 meses)', async () => {
  const state = demoState();
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'ajustes');
  const rows = await page.locator('#set-codes .codes-card > .code-row').count();
  assert.ok(rows <= 8, `pocas filas a la vista (${rows})`);
  for (const c of ['F1', 'S1', 'N1', 'Z1']) assert.ok(await visible(page, `.code-row[data-code="${c}"]`), c);
  assert.equal(await page.locator('#set-codes .codes-card > .code-row[data-code="F51"]').count(), 0, 'los lugares no van sueltos');
  assert.match(await text(page, '[data-testid="places"] > summary'), /Lugares \(\d+\)/);
  assert.equal(await page.locator('.code-row[data-code="F51"]').first().isVisible(), false);
  await page.click('[data-testid="places"] > summary');
  assert.ok(await visible(page, '.code-row[data-code="F51"]'));
  return { ctx, errors };
});

test('diálogos: cerrar antes del primer fotograma no los deja abiertos; un aviso persistente no se pierde', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  const r = await page.evaluate(async () => {
    const { busyDialog, confirmDialog } = await import('./js/ui/sheet.js');
    const b = busyDialog('Conectando…');
    b.close();
    const p = confirmDialog({ title: 'Prueba' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const answer = await p;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const open = document.querySelectorAll('.dialog-wrap.open').length;
    const { toast } = await import('./js/ui/toast.js');
    window.__closed = null;
    toast('Hay una nueva versión de la app.', { duration: 0, onClose: (why) => { window.__closed = why; }, action: { label: 'Actualizar', run: () => {} } });
    for (const t of ['uno', 'dos', 'tres', 'cuatro']) toast(t);
    await new Promise((res) => setTimeout(res, 300));
    return { answer, open, sticky: [...document.querySelectorAll('.toast-sticky:not(.toast-leaving)')].map((t) => t.textContent) };
  });
  assert.equal(r.answer, false);
  assert.equal(r.open, 0, 'ningún diálogo se queda abierto');
  assert.equal(r.sticky.length, 1, 'el aviso de «nueva versión» sigue ahí');
  await page.click('.toast-sticky .toast-text');
  assert.equal(await page.evaluate(() => window.__closed), 'dismiss', 'al cerrarlo se avisa (para volver a ofrecerlo)');
  return { ctx, errors };
});

// ---------- SPEC §11–§14: varias personas, Android, funciones nuevas y diseño adaptable ----------

// GitHub con el calendario de Mauricio (raíz) y, si se pide, el de Ana (carpeta «ana», otra clave)
async function familyGitHub({ ana = true } = {}) {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'iphone1', name: 'Mauricio' });
  if (ana) {
    let st = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
    st = core.setDay(st, '2026-10-14', ['S1'], { now: new Date('2026-10-10T10:00:00Z') });
    await seedRemote(gh, st, { deviceId: 'android-ana', dir: 'ana', key: OTHER_KEY, name: 'Ana' });
  }
  return gh;
}
// Simula el aviso de instalación de Chrome (beforeinstallprompt)
const fakeInstallPrompt = (page, outcome = 'accepted') => page.evaluate((o) => {
  window.__prompted = false;
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = async () => { window.__prompted = true; };
  e.userChoice = Promise.resolve({ outcome: o });
  window.dispatchEvent(e);
}, outcome);
const RECORDING_STUB = `export async function recognize(input, o = {}) { globalThis.__employeeName = o.employeeName; o.onProgress?.(1, 'Listo');
  return { layout: 'unknown', month: null, year: null, days: [], warnings: [] }; }
export async function dispose() {}`;

test('primer uso: nombre y nombre del plan (saltables) → saludo, Ajustes «Tu nombre» y la tabla del PC', async () => {
  const { page, ctx, errors } = await openApp();
  await page.waitForSelector('.onboarding.open');
  await page.click('[data-testid="ob-next"]');
  assert.match(await text(page, '.ob-step[data-step="name"]'), /¿Cómo te llamas\?[\s\S]*¿Cómo sale tu nombre en el plan\?/);
  await page.fill('[data-testid="ob-name"]', '  Ana ');
  assert.equal(await page.getAttribute('[data-testid="ob-plan-name"]', 'placeholder'), 'Ej.: Ducuara Ana', 'sugiere «Ducuara <nombre>»');
  await page.fill('[data-testid="ob-plan-name"]', 'Ducuara Ana');
  await page.click('[data-testid="ob-next"]');
  assert.match(await text(page, '.ob-step'), /Avisos antes de trabajar/);
  let s = await getState(page);
  assert.equal(s.settings.name, 'Ana');
  assert.equal(s.settings.planName, 'Ducuara Ana');
  await page.click('[data-testid="ob-next"]');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  await tab(page, 'hoy');
  assert.equal(await text(page, '#view-hoy .large-title'), 'Hola, Ana 👋');
  // Ajustes → «Tu nombre»: se puede cambiar
  await tab(page, 'ajustes');
  assert.equal(await page.inputValue('#set-name [data-fkey="name"]'), 'Ana');
  assert.equal(await page.inputValue('#set-name [data-fkey="planName"]'), 'Ducuara Ana');
  await page.fill('#set-name [data-fkey="name"]', 'Lucía');
  await page.press('#set-name [data-fkey="name"]', 'Tab');
  await waitState(page, (st) => st.settings.name === 'Lucía');
  await tab(page, 'hoy');
  assert.equal(await text(page, '#view-hoy .large-title'), 'Hola, Lucía 👋');
  // Escanear: el lector busca la fila con el nombre del plan
  await page.route('**/docs/js/recognize/index.js', (r) => r.fulfill({ contentType: 'text/javascript', body: RECORDING_STUB }));
  await tab(page, 'escanear');
  await page.setInputFiles('input[data-testid="scan-pick"]', PHOTO);
  await page.waitForSelector('.fallback', { timeout: 20000 });
  assert.equal(await page.evaluate(() => globalThis.__employeeName), 'Ducuara Ana');
  s = await getState(page);
  assert.equal(s.settings.planName, 'Ducuara Ana');
  return { ctx, errors };
});

test('primer uso saltado: sin nombre, saludo neutro y el lector usa «Ducuara»', async () => {
  const { page, ctx, errors } = await openApp();
  await page.waitForSelector('.onboarding.open');
  await page.click('[data-testid="ob-next"]');
  await page.click('.ob-skip');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  const s = await getState(page);
  assert.equal(s.settings.name, '');
  assert.equal(s.settings.planName, '');
  assert.equal(await text(page, '#view-hoy .large-title'), 'Hola 👋');
  await page.route('**/docs/js/recognize/index.js', (r) => r.fulfill({ contentType: 'text/javascript', body: RECORDING_STUB }));
  await tab(page, 'escanear');
  await page.setInputFiles('input[data-testid="scan-pick"]', PHOTO);
  await page.waitForSelector('.fallback', { timeout: 20000 });
  assert.equal(await page.evaluate(() => globalThis.__employeeName), 'Ducuara');
  return { ctx, errors };
});

test('Android: «Calendario del teléfono», ICSx⁵ (intent) primero y Google Calendar después, sin avisos de Safari', async () => {
  const gh = await familyGitHub();
  const state = core.updateSettings(demoState(), { name: 'Ana', sync: { ...SYNC, key: OTHER_KEY, dir: 'ana', deviceId: 'android-ana' } });
  const { page, ctx, errors } = await openApp({ state, gh, device: 'android', standalone: false, width: 360, height: 740 });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.platform), 'android');
  assert.equal(await page.locator('[data-testid="banner-safari"]').count(), 0, 'en Android no hay aviso de Safari');
  await page.waitForSelector('[data-testid="sync-line"]');
  assert.match(await text(page, '[data-testid="sync-line"]'), /^Tu calendario al día/);
  assert.doesNotMatch(await text(page, '#view-hoy'), /iPhone/);
  await tab(page, 'ajustes');
  assert.match(await page.locator('#set-calendar .set-title').textContent(), /^Calendario del teléfono$/);
  const href = await page.getAttribute('#set-calendar [data-testid="webcal"]', 'href');
  assert.equal(href, `intent://raw.githubusercontent.com/${OWNER}/${REPO}/HEAD/ana/turnos.ics#Intent;scheme=webcals;package=at.bitfire.icsdroid;S.browser_fallback_url=${encodeURIComponent('https://play.google.com/store/apps/details?id=at.bitfire.icsdroid')};end`);
  assert.match(await text(page, '#set-calendar [data-testid="webcal"]'), /Ver mis turnos en el calendario/);
  assert.match(await text(page, '#set-calendar [data-testid="alerts-notice"]'), /Ignore alerts embedded in the calendar/);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#set-calendar [data-testid="copy-cal-link"]');
  await page.waitForSelector('.toast:has-text("Enlace copiado")');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `https://raw.githubusercontent.com/${OWNER}/${REPO}/HEAD/ana/turnos.ics`);
  // Las dos guías, la recomendada primero
  const guides = await page.locator('#set-calendar .guide-group > details > summary').allInnerTexts();
  assert.match(guides[0], /ICSx⁵ \(recomendado\)/);
  assert.match(guides[1], /Google Calendar/);
  await page.click('details[data-fkey="guide-icsx5"] > summary');
  const icsx5 = await text(page, 'details[data-fkey="guide-icsx5"]');
  // Orden real de ICSx⁵ 2.4: «SUBSCRIBE» en la 1.ª pantalla; en la 2.ª («Alarms») solo la flecha →, que
  // la crea y cierra ICSx⁵; el intervalo se pone después, abriéndola desde su icono
  assert.match(icsx5, /Google Play[\s\S]*1,99 €[\s\S]*Permitir[\s\S]*SUBSCRIBE[\s\S]*Título y color[\s\S]*Ignore alerts embedded in the calendar[\s\S]*flecha →[\s\S]*se cierra[\s\S]*desde su icono[\s\S]*Mis suscripciones[\s\S]*Cada hora[\s\S]*Sin restricciones/);
  assert.doesNotMatch(icsx5, /Ignore alerts embedded in the calendar[^\n]*\n[^\n]*SUBSCRIBE/, '«SUBSCRIBE» no va después de «Alarms»');
  assert.match(icsx5, /«Turnos de Ana»/);
  await page.click('details[data-fkey="guide-google"] > summary');
  assert.match(await text(page, 'details[data-fkey="guide-google"]'), /calendar\.google\.com[\s\S]*Desde una URL[\s\S]*Agregar notificación/);
  // Sin «iPhone» en Ajustes (salvo la guía de otra persona, que no está abierta)
  assert.doesNotMatch(await page.evaluate(() => document.getElementById('view-ajustes').innerText), /iPhone/);
  // «Ver sus turnos» de Mauricio: guía para mirar sin sus avisos
  await page.waitForSelector('#set-family');
  await page.click('#set-family [data-dir="_"] [data-testid="family-subscribe"]');
  await sheetOpen(page);
  assert.match(await page.getAttribute('[data-testid="family-open-android"]', 'href'), new RegExp(`^intent://raw\\.githubusercontent\\.com/${OWNER}/${REPO}/HEAD/turnos\\.ics#Intent;scheme=webcals;`));
  assert.match(await text(page, '[data-testid="family-guide"]'), /activa «Ignore alerts embedded in the calendar»/);
  return { ctx, errors };
});

test('Android: botón «Instalar la app» (beforeinstallprompt) y guía del menú ⋮', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), device: 'android', standalone: false });
  await tab(page, 'ajustes');
  assert.match(await text(page, '#set-install'), /menú ⋮[\s\S]*Instalar app/);
  assert.equal(await page.locator('#set-install [data-testid="install-prompt"]').count(), 0, 'sin aviso de Chrome todavía');
  assert.doesNotMatch(await text(page, '#set-install'), /Safari/);
  await fakeInstallPrompt(page);
  await page.waitForSelector('#set-install [data-testid="install-prompt"]');
  await page.click('#set-install [data-testid="install-prompt"]');
  await page.waitForFunction(() => window.__prompted === true);
  await page.waitForSelector('#set-install [data-testid="install-prompt"]', { state: 'detached' });
  return { ctx, errors };
});

test('Android: «Atrás» cierra la hoja o el diálogo (y pregunta si hay cambios) sin salir de la app', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), device: 'android', standalone: false });
  const url = page.url();
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheetOpen(page);
  await page.evaluate(() => history.back());
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.equal(page.url(), url, 'sigue en la app');
  assert.ok(await visible(page, '#view-calendario'));
  // Con cambios: «Atrás» pregunta; «Atrás» otra vez sigue editando
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="S1"]');
  await page.evaluate(() => history.back());
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Salir sin guardar/);
  await page.waitForTimeout(150);
  await page.evaluate(() => history.back());
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  assert.ok(await visible(page, '.sheet-day'), 'la hoja sigue abierta');
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.deepEqual((await getState(page)).days['2026-10-14'].codes, ['S1']);
  // Cerrada desde la app: no queda la entrada extra en el historial
  await page.waitForTimeout(200);
  assert.ok(!(await page.evaluate(() => history.state?.turnosBack)), 'sin entrada pendiente');
  // La bienvenida: «Atrás» vuelve un paso
  await page.evaluate(() => import('./js/ui/onboarding.js').then((m) => m.showOnboarding(window.__turnosTest && { store: window.__turnosTest.store, go: window.__turnosTest.go, repaint: () => {} }, { again: true })));
  await page.waitForSelector('.onboarding.open');
  await page.click('[data-testid="ob-next"]');
  await page.waitForSelector('.ob-step[data-step="name"]');
  await page.evaluate(() => history.back());
  await page.waitForSelector('.ob-step[data-step="welcome"]');
  await page.evaluate(() => history.back());
  await page.waitForSelector('.onboarding', { state: 'detached' });
  assert.equal(page.url(), url);
  return { ctx, errors };
});

test('iPhone: cerrar hojas con ✕ o Escape no deja entradas en el historial', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  const before = await page.evaluate(() => history.length);
  await tab(page, 'calendario');
  for (let i = 0; i < 3; i++) {
    await page.click('.day-row[data-key="2026-10-14"]');
    await sheetOpen(page);
    if (i % 2) await page.keyboard.press('Escape'); else await page.click('.sheet-close');
    await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  }
  await page.waitForTimeout(200);
  assert.ok(!(await page.evaluate(() => history.state?.turnosBack)));
  // El historial no crece sin límite (cada hoja quita su entrada)
  assert.ok(await page.evaluate(() => history.length) <= before + 1);
  return { ctx, errors };
});

test('varias personas: «Crear enlace para otra persona» (carpeta y clave nuevas) y «Calendarios de la familia»', async () => {
  const gh = await familyGitHub();
  const state = core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'iphone1' } });
  const { page, ctx, errors } = await openApp({ state, gh });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt || s.settings.sync.lastPushAt));
  await tab(page, 'ajustes');
  await page.waitForSelector('#set-family', { timeout: 10000 });
  const items = page.locator('#set-family [data-testid="family-item"]');
  assert.equal(await items.count(), 2);
  assert.match(await items.nth(0).innerText(), /Mauricio[\s\S]*Tu calendario[\s\S]*Tú/);
  assert.match(await items.nth(1).innerText(), /Ana/);
  assert.match(await text(page, '#set-family'), /deja activado «Eliminar alertas»/);
  // iPhone: antes de suscribirse, el aviso «deja ACTIVADO Eliminar alertas»; la suscripción sale de su botón
  await page.evaluate(() => document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="webcal:"]');
    if (a) { e.preventDefault(); window.__opened = a.href; }
  }, true));
  await page.click('#set-family [data-dir="ana"] [data-testid="family-subscribe"]');
  await page.waitForSelector('.dialog-wrap.open [data-testid="family-ios-notice"]');
  assert.match(await text(page, '.dialog-wrap.open .dialog-title'), /Turnos de Ana: solo para mirar/);
  assert.match(await text(page, '.dialog-wrap.open .dialog-strong'), /Cuando el iPhone lo pregunte, deja ACTIVADO «Eliminar alertas»/);
  assert.equal(await page.evaluate(() => window.__opened || null), null, 'todavía no se abre nada');
  await page.click('.dialog-wrap.open .btn-primary');
  await page.waitForFunction(() => Boolean(window.__opened));
  assert.equal(await page.evaluate(() => window.__opened), `webcal://raw.githubusercontent.com/${OWNER}/${REPO}/HEAD/ana/turnos.ics`);
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  // Crear enlace para otra persona
  await page.click('[data-testid="advanced"] > summary');
  assert.match(await text(page, '[data-testid="make-link"]'), /Crear enlace para Mauricio/);
  await page.click('[data-testid="make-person-link"]');
  await sheetOpen(page);
  await page.click('[data-testid="person-create"]');
  assert.match(await text(page, '.sheet-person .form-error'), /Escribe el nombre/);
  await page.fill('[data-testid="person-name"]', 'Ana');
  await page.click('[data-testid="person-create"]');
  await page.waitForSelector('[data-testid="person-result"]:not([hidden])');
  const link = await page.locator('[data-testid="person-link"]').textContent();
  const cfg = core.parseSetupLink(link);
  assert.equal(cfg.dir, 'ana-2', 'no repite la carpeta de Ana que ya existe');
  assert.equal(cfg.name, 'Ana');
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.owner, OWNER);
  assert.ok(core.isSyncKey(cfg.key) && cfg.key !== KEY && cfg.key !== OTHER_KEY, 'clave nueva');
  assert.match(await text(page, '[data-testid="person-result"]'), /carpeta «ana-2»[\s\S]*En Android[\s\S]*En iPhone/);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('[data-testid="person-copy"]');
  await page.waitForSelector('.toast:has-text("Enlace copiado")');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
  assert.equal((await getState(page)).settings.sync.dir, '', 'este dispositivo no cambia de carpeta');
  assert.equal(gh.writes().filter((l) => /ana-2/.test(l)).length, 0, 'crear el enlace no escribe nada');
  return { ctx, errors };
});

test('varias personas: el enlace de Ana abierto en su Android publica en «ana/» sin tocar el calendario de Mauricio', async () => {
  const gh = await familyGitHub({ ana: false });
  const rootBackup = gh.text('backup.json');
  const rootIcs = gh.text('turnos.ics');
  const seeded = gh.writes().length;
  const p = core.buildPersonLink(APP, { owner: OWNER, repo: REPO, branch: '', token: TOKEN }, { name: 'Ana', existingDirs: [''] });
  let st = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  st = core.setDay(st, '2026-10-14', ['S1'], { now: new Date('2026-10-12T10:00:00Z') });
  const { page, ctx, errors } = await openApp({ state: st, gh, hash: p.link.slice(APP.length), device: 'android', standalone: false });
  await page.waitForSelector('.dialog-wrap.open');
  const confirm = await text(page, '.dialog-wrap.open .dialog');
  assert.match(confirm, /Conectar el calendario del teléfono/);
  assert.match(confirm, /para Ana/);
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await page.waitForSelector('.sheet-subscribe [data-testid="webcal"][aria-disabled="false"]', { timeout: 15000 });
  assert.match(await page.getAttribute('.sheet-subscribe [data-testid="webcal"]', 'href'), /^intent:\/\/raw\.githubusercontent\.com\/[^#]+\/HEAD\/ana\/turnos\.ics#Intent;scheme=webcals;package=at\.bitfire\.icsdroid;/);
  assert.match(await text(page, '[data-testid="subscribe-step"]'), /ICSx⁵[\s\S]*Cada hora/);
  assert.ok(await visible(page, '.sheet-subscribe [data-testid="copy-cal-link"]'), '«Copiar enlace» siempre');
  const s = await getState(page);
  assert.equal(s.settings.sync.dir, 'ana');
  assert.equal(s.settings.name, 'Ana', 'el nombre del enlace se guarda (no tenía)');
  assert.equal(s.settings.sync.key, p.key);
  const backup = gh.json('ana/backup.json');
  assert.equal(backup.meta.publisher, s.settings.sync.deviceId, 'el teléfono de Ana publica su carpeta');
  assert.equal(backup.meta.name, 'Ana');
  assert.match(gh.text('ana/turnos.ics'), /X-WR-CALNAME:Turnos de Ana/);
  assert.equal(gh.text('backup.json'), rootBackup, 'la copia de Mauricio no cambia');
  assert.equal(gh.text('turnos.ics'), rootIcs, 'el calendario de Mauricio no cambia');
  const mine = gh.writes().slice(seeded);
  assert.ok(mine.length >= 2 && mine.every((l) => /\/contents\/ana\//.test(l)), `solo escribe en ana/: ${mine.join(', ')}`);
  await page.click('.sheet-subscribe .sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await tab(page, 'hoy');
  assert.equal(await text(page, '#view-hoy .large-title'), 'Hola, Ana 👋');
  return { ctx, errors };
});

test('Horas: suplementos del mes (con € si hay salario) y saldos (horas y vacaciones del año)', async () => {
  let state = demoState();
  state = core.updateSettings(state, { supplements: { hourlyWage: 20 }, balances: { overtimeStartMin: 90, overtimeStartMonth: '2026-08', vacationCarryOver: 2.5 } });
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'horas');
  const sp = core.monthSummary(state, 2026, 10).supplements;
  for (const k of ['night', 'saturday', 'sunday', 'holiday']) {
    assert.equal(await text(page, `[data-testid="supplements"] [data-kind="${k}"] .sup-hours`), core.formatHours(sp[k].minutes), k);
  }
  const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(sp.euros);
  assert.match(await text(page, '[data-testid="supplements-total"]'), new RegExp(`≈ ${eur.replace(/[.\s]/g, '.')}`));
  assert.match(await text(page, '[data-testid="supplements"]'), /Comprueba tu contrato/);
  const ob = core.overtimeBalance(state, { now: NOW });
  assert.equal(await text(page, '[data-testid="overtime"] .bal-value'), core.formatSignedHours(ob.balance));
  assert.match(await text(page, '[data-testid="overtime"]'), /Desde agosto 2026\./);
  assert.equal(await text(page, '[data-testid="bal-start"] b'), '+1 h 30');
  assert.equal(await sumBalanceRows(page), ob.balance, 'las líneas suman el total');
  const vac = core.vacationSummary(state, 2026, { now: NOW });
  assert.match(await text(page, '[data-testid="vacation"] .bal-value'), new RegExp(`^${String(vac.remaining).replace('.', ',')} días`));
  assert.match(await text(page, '[data-testid="vacation"]'), new RegExp(`Usadas: ${vac.used} días`));
  // Sin salario: invita a ponerlo → Ajustes «Contrato y nómina» abierto
  await page.evaluate(() => window.__turnosTest.store.set((s) => { s.settings.supplements.hourlyWage = null; return s; }));
  await page.click('[data-testid="supplements"] .sup-wage');
  await page.waitForFunction(() => document.getElementById('set-payroll')?.open === true);
  await page.fill('[data-fkey="wage"]', '18,5');
  await page.press('[data-fkey="wage"]', 'Tab');
  await waitState(page, (s) => s.settings.supplements.hourlyWage === 18.5);
  await page.fill('[data-fkey="vac-days"]', '28');
  await page.press('[data-fkey="vac-days"]', 'Tab');
  await waitState(page, (s) => s.settings.balances.vacationDaysPerYear === 28);
  await page.fill('[data-fkey="ot-start"]', '-3,5');
  await page.press('[data-fkey="ot-start"]', 'Tab');
  await waitState(page, (s) => s.settings.balances.overtimeStartMin === -210);
  await page.fill('[data-fkey="sup-night"]', '400');
  await page.press('[data-fkey="sup-night"]', 'Tab');
  await page.waitForSelector('.toast-error:has-text("porcentaje")');
  assert.equal((await getState(page)).settings.supplements.night.pct, 26, 'un valor no válido no se guarda');
  await page.fill('[data-fkey="sup-sunday"]', '50');
  await page.press('[data-fkey="sup-sunday"]', 'Tab');
  await waitState(page, (s) => s.settings.supplements.sunday.pct === 50);
  await page.selectOption('[data-fkey="ot-month"]', '2026-09');
  await waitState(page, (s) => s.settings.balances.overtimeStartMonth === '2026-09');
  return { ctx, errors };
});

test('Ajustes: «Contrato y nómina» plegado por defecto, con el aviso «comprueba tu contrato»', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'ajustes');
  assert.equal(await page.evaluate(() => document.getElementById('set-payroll').open), false);
  assert.equal(await page.locator('[data-fkey="wage"]').isVisible(), false);
  await page.click('[data-testid="payroll"] > summary');
  assert.match(await text(page, '[data-testid="payroll-note"]'), /Comprueba tu contrato/);
  for (const k of ['vac-days', 'vac-carry', 'ot-start', 'ot-month', 'sup-night', 'sup-night-from', 'sup-night-to', 'sup-saturday', 'sup-sunday', 'sup-holiday', 'wage']) {
    assert.ok(await page.locator(`[data-fkey="${k}"]`).isVisible(), k);
  }
  assert.equal(await page.inputValue('[data-fkey="sup-night-from"]'), '23:00');
  return { ctx, errors };
});

test('tiempo de viaje: el lugar con 25 min → «Sal a las 13:05 hacia S51» en Hoy y «Abrir en Mapas»', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  assert.equal(await page.locator('[data-testid="travel-fact"]').count(), 0, 'sin viaje no se dice');
  await tab(page, 'ajustes');
  await page.click('[data-testid="places"] > summary');
  await page.click('.code-row[data-code="S51"]');
  await sheetOpen(page);
  assert.equal(await page.locator('.sheet-code [data-testid="ce-maps"]').isVisible(), false, 'sin dirección no hay mapa');
  await page.fill('.sheet-code input[placeholder^="Ej.: Karl"]', 'Karl-Marx-Straße 101, Berlín');
  assert.equal(await page.getAttribute('.sheet-code [data-testid="ce-maps"]', 'href'), `https://maps.apple.com/?q=${encodeURIComponent('Karl-Marx-Straße 101, Berlín')}`);
  await page.selectOption('[data-testid="ce-travel"]', '25');
  assert.match(await text(page, '.ce-preview'), /25 min de viaje/);
  await page.click('[data-testid="code-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.equal((await getState(page)).codes.S51.travelMin, 25);
  assert.match(await text(page, '.code-row[data-code="S51"]'), /25 min de viaje/);
  await tab(page, 'hoy');
  assert.equal(await text(page, '[data-testid="travel-fact"]'), 'Sal a las 13:05 hacia S51 (25 min de viaje)');
  assert.match(await page.getAttribute('#view-hoy [data-testid="maps-link"]', 'href'), /^https:\/\/maps\.apple\.com\/\?q=/);
  // Tocar «Mapa» no abre el editor del día
  await page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest('a[data-testid="maps-link"]')) e.preventDefault(); }));
  await page.click('#view-hoy [data-testid="maps-link"]');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.sheet-wrap').count(), 0);
  return { ctx, errors };
});

test('recordatorios: «Avisarme para subir el plan» (activado) se puede apagar y quita el aviso del calendario', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'ajustes');
  const sw = '#set-reminders [data-fkey="planUpload"]';
  assert.equal(await page.isChecked(sw), true);
  assert.match(core.buildICS(await getState(page), { now: NOW }), /UID:plan-2026-11@/);
  await page.click(sw);
  await waitState(page, (s) => s.settings.reminders.planUpload === false);
  assert.doesNotMatch(core.buildICS(await getState(page), { now: NOW }), /UID:plan-/);
  return { ctx, errors };
});

test('enfermedad: K «Enfermedad» en la paleta, se guarda y acredita la jornada', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-20"]');
  await sheetOpen(page);
  const tile = page.locator('.sheet .tile[data-code="K"]');
  assert.ok(await tile.isVisible(), 'K a mano, sin «Más códigos»');
  assert.match(await tile.getAttribute('aria-label'), /K Enfermedad/);
  await tile.click();
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  const s = await getState(page);
  assert.deepEqual(s.days['2026-10-20'].codes, ['K']);
  assert.equal(core.dayMinutes(s, '2026-10-20').credited, 7 * 60);
  assert.match(await text(page, '.day-row[data-key="2026-10-20"]'), /Enfermedad/);
  return { ctx, errors };
});

test('ordenador (1280×800): columna central, pestañas y hojas centradas; teclado (Escape, flechas y foco)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), device: 'desktop', width: 1280, height: 800, standalone: false });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.platform), 'desktop');
  const box = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, vw: innerWidth }; }, sel);
  const views = await box('#views');
  assert.ok(views.w <= 720, `columna de ${views.w} px`);
  assert.ok(Math.abs(views.l - (views.vw - views.r)) <= 1, 'columna centrada');
  for (const sel of ['.hero', '.week-card']) assert.ok((await box(sel)).w <= 680, `${sel} sin estirarse`);
  const bar = await box('.tabbar');
  assert.ok(bar.w <= 600 && Math.abs(bar.l - (bar.vw - bar.r)) <= 1, `barra de pestañas centrada (${JSON.stringify(bar)})`);
  assert.equal(await page.locator('[data-testid="banner-safari"]').count(), 0);
  assert.doesNotMatch(await text(page, '#view-hoy'), /iPhone/);
  // Hoja centrada; Escape la cierra
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheetOpen(page);
  const sh = await box('.sheet');
  assert.ok(sh.w <= 620 && Math.abs(sh.l - (sh.vw - sh.r)) <= 1, `hoja centrada (${JSON.stringify(sh)})`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  // Flechas: mes siguiente / anterior
  await page.keyboard.press('ArrowRight');
  assert.match(await text(page, '.nav-title'), /Noviembre 2026/);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert.match(await text(page, '.nav-title'), /Septiembre 2026/);
  // Tabulador: el foco se ve
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.notEqual(outline, 'none', 'foco visible con el teclado');
  return { ctx, errors };
});

test('diseño: nada se sale a 360 px en Android ni en tablet (820 y 1180) con lo nuevo abierto', async () => {
  const problems = [];
  for (const [device, width, height] of [['android', 360, 740], ['ipad', 820, 1180], ['ipad', 1180, 820]]) {
    let state = demoState({ sync: true });
    state = core.upsertCode(state, { ...core.getCode(state, 'S51'), place: 'Karl-Marx-Straße 101, Berlín', travelMin: 25 });
    state = core.updateSettings(state, { name: 'Ana', supplements: { hourlyWage: 18.5 } });
    const { page, ctx } = await openApp({ state, device, width, height, standalone: device !== 'android' });
    for (const id of ['hoy', 'calendario', 'escanear', 'horas', 'ajustes']) {
      await tab(page, id);
      if (id === 'ajustes') { await page.click('[data-testid="payroll"] > summary'); await page.click('#set-advanced > summary'); }
      await page.waitForTimeout(150);
      problems.push(...(await findOverflow(page)).map((p) => `${device} ${width}: ${id}: ${p}`));
    }
    await ctx.close();
  }
  assert.deepEqual(problems, []);
  return { ctx: null, errors: [] };
});

test('iPad: dice «iPad» (no «iPhone») en el calendario, la suscripción y los consejos', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState({ sync: true }), gh: fakeGitHub(), device: 'ipad', width: 820, height: 1180 });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.platform), 'ios');
  await tab(page, 'ajustes');
  assert.equal((await page.locator('#set-calendar .set-title').textContent()).trim(), 'Calendario del iPad');
  assert.match(await text(page, '#set-calendar [data-testid="webcal"]'), /Suscribirme en el iPad/);
  assert.match(await text(page, '#set-calendar [data-testid="alerts-notice"]'), /cuando el iPad lo pregunte/);
  assert.match(await text(page, '#set-reminders'), /Calendario del iPad[\s\S]*«Suscribirme en el iPad»/);
  for (const id of ['hoy', 'calendario', 'horas', 'ajustes']) {
    await tab(page, id);
    assert.doesNotMatch(await text(page, `#view-${id}`), /iPhone/, id);
  }
  return { ctx, errors };
});

test('textos: «calendario del teléfono» en minúscula dentro de las frases (Android)', async () => {
  const state = core.updateSettings(demoState(), { name: 'Ana' });
  const { page, ctx, errors } = await openApp({ state, device: 'android', standalone: false, width: 360, height: 740 });
  await tab(page, 'ajustes');
  assert.equal((await page.locator('#set-calendar .set-title').textContent()).trim(), 'Calendario del teléfono', 'el título de la sección sí');
  assert.match(await text(page, '[data-testid="sync-status"]'), /no salen en el calendario del teléfono/);
  assert.match(await text(page, '#set-reminders'), /falta conectar el calendario del teléfono/);
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheetOpen(page);
  assert.match(await text(page, '.sheet-day'), /La nota no sale en el calendario del teléfono/);
  return { ctx, errors };
});

test('Android: antes de suscribirse, Ajustes explica que ICSx⁵ se instala primero (1,99 €), antes del botón', async () => {
  const gh = await familyGitHub();
  const state = core.updateSettings(demoState(), { name: 'Ana', sync: { ...SYNC, key: OTHER_KEY, dir: 'ana', deviceId: 'android-ana' } });
  const { page, ctx, errors } = await openApp({ state, gh, device: 'android', standalone: false, width: 360, height: 740 });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  await tab(page, 'ajustes');
  await page.waitForSelector('#set-calendar [data-testid="webcal"][aria-disabled="false"]');
  const card = await text(page, '#set-calendar .cal-card');
  assert.match(card, /Instala «ICSx⁵» desde Google Play \(cuesta 1,99 €\)[\s\S]*SUBSCRIBE[\s\S]*flecha →[\s\S]*Cada hora[\s\S]*Ver mis turnos en el calendario/);
  // Los pasos van antes del botón
  const order = await page.evaluate(() => {
    const st = document.querySelector('#set-calendar .cal-card .steps');
    const btn = document.querySelector('#set-calendar [data-testid="webcal"]');
    return Boolean(st.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.ok(order, 'pasos y después el botón');
  return { ctx, errors };
});

test('calendario a 360 px: el mes y las semanas se leen enteros («Septiembre 2026», «12–18 oct», «31 ago – 6 sept»)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), device: 'android', standalone: false, width: 360, height: 740 });
  await tab(page, 'calendario');
  assert.equal(await text(page, '[data-week="2026-10-12"] .week-sep-range'), '12–18 oct');
  const clipped = [];
  for (let i = 0; i < 4; i++) {
    if (i) await page.click('[aria-label="Mes siguiente"]');
    clipped.push(...await page.evaluate(() => [...document.querySelectorAll('.nav-title, .week-sep-range')]
      .filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent)));
  }
  // Septiembre (con la semana del 31 de agosto)
  for (let i = 0; i < 4; i++) await page.click('[aria-label="Mes anterior"]');
  assert.equal(await text(page, '.nav-title'), 'Septiembre 2026');
  assert.equal(await text(page, '[data-week="2026-08-31"] .week-sep-range'), '31 ago – 6 sept');
  clipped.push(...await page.evaluate(() => [...document.querySelectorAll('.nav-title, .week-sep-range')]
    .filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent)));
  assert.deepEqual(clipped, [], 'nada cortado con «…»');
  return { ctx, errors };
});

test('editar día: «Sal a las…» y «Abrir en Mapas» en el turno; un libre no dice «0 h de trabajo»', async () => {
  let state = demoState();
  state = core.upsertCode(state, { ...core.getCode(state, 'S51'), place: 'Karl-Marx-Straße 101, Berlín', travelMin: 25 });
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-13"]');
  await sheetOpen(page);
  assert.equal(await text(page, '.sheet-day [data-testid="day-travel"]'), 'Sal a las 13:05 hacia S51 (25 min de viaje)');
  assert.equal(await page.getAttribute('.sheet-day [data-testid="day-maps"]', 'href'), `https://maps.apple.com/?q=${encodeURIComponent('Karl-Marx-Straße 101, Berlín')}`);
  // Horario especial: la hora de salir cambia con él
  await page.click('.sheet-day [data-testid="day-time-edit"]');
  await page.fill('.sheet-day [data-testid="day-time-start"]', '15:00');
  await page.waitForFunction(() => /14:35/.test(document.querySelector('.sheet-day [data-testid="day-travel"]').textContent));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .btn-danger');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  // Un día libre
  const off = Object.entries(state.days).find(([k, d]) => k >= '2026-10-01' && d.codes.length === 1 && d.codes[0] === '-')[0];
  await page.click(`.day-row[data-key="${off}"]`);
  await sheetOpen(page);
  assert.equal(await page.locator('.sheet-day .de-summary').isVisible(), false);
  assert.doesNotMatch(await text(page, '.sheet-day .de-selected'), /0 h de trabajo/);
  return { ctx, errors };
});

test('códigos: «Restablecer» un lugar dice que borra la dirección y el viaje, y se puede deshacer', async () => {
  let state = demoState();
  state = core.upsertCode(state, { ...core.getCode(state, 'S51'), place: 'Karl-Marx-Straße 101, Berlín', travelMin: 25 });
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'ajustes');
  await page.click('[data-testid="places"] > summary');
  await page.click('.code-row[data-code="S51"]');
  await sheetOpen(page);
  await page.click('.sheet-code .btn-danger-plain');
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog-text'), /se borrarán su dirección y su tiempo de viaje/);
  await page.click('.dialog-wrap.open .btn-danger');
  await waitState(page, (s) => !s.codes.S51.place);
  await page.click('.toast .toast-action:has-text("Deshacer")');
  await waitState(page, (s) => s.codes.S51.place === 'Karl-Marx-Straße 101, Berlín' && s.codes.S51.travelMin === 25);
  return { ctx, errors };
});

test('Horas: el saldo muestra los meses anteriores y el saldo inicial (las líneas suman el total)', async () => {
  const state = core.updateSettings(demoState(), { balances: { overtimeStartMin: 300 } });
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'horas');
  const ob = core.overtimeBalance(state, { now: NOW });
  assert.ok(ob.months.length > 3, 'hay más de 3 meses con plan');
  assert.equal(await text(page, '[data-testid="overtime"] .bal-value'), core.formatSignedHours(ob.balance));
  assert.match(await text(page, '[data-testid="bal-earlier"]'), new RegExp(`Meses anteriores \\(${ob.months.length - 3}\\)`));
  assert.equal(await text(page, '[data-testid="bal-start"] b'), '+5 h');
  assert.equal(await sumBalanceRows(page), ob.balance);
  return { ctx, errors };
});

test('teclado: «Próximo turno» es un botón de verdad (Espacio abre el día) y «Esta semana» responde a Espacio', async () => {
  let state = demoState();
  state = core.upsertCode(state, { ...core.getCode(state, 'S51'), place: 'Karl-Marx-Straße 101, Berlín' });
  const { page, ctx, errors } = await openApp({ state, device: 'desktop', width: 1280, height: 800, standalone: false });
  assert.equal(await page.locator('.hero[role="button"], .hero [role="button"]').count(), 0, 'sin role=button con enlaces dentro');
  assert.equal(await page.locator('[data-testid="hero-open"] a, [data-testid="hero-open"] button').count(), 0);
  await page.focus('[data-testid="hero-open"]');
  await page.keyboard.press('Space');
  await sheetOpen(page);
  assert.match(await text(page, '.sheet-title'), /13 de octubre/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.focus('.week-card');
  await page.keyboard.press('Space');
  await page.waitForSelector('#view-calendario:not([hidden])');
  return { ctx, errors };
});

test('teclado: con Tab, el foco nunca queda debajo de la barra de pestañas (ordenador e iPhone)', async () => {
  const hidden = [];
  for (const [device, width, height] of [['desktop', 1280, 800], [undefined, 390, 844]]) {
    const { page, ctx } = await openApp({ state: demoState({ sync: true }), device, width, height, standalone: device !== 'desktop' });
    await tab(page, 'ajustes');
    await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el.closest('.tabbar')) return null;
        const a = el.getBoundingClientRect(), bar = document.querySelector('.tabbar').getBoundingClientRect();
        if (a.height > innerHeight / 2) return null;
        return a.bottom > bar.top + 1 ? `${el.tagName} «${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}»` : null;
      });
      if (r) hidden.push(`${device || 'iphone'}: ${r}`);
    }
    await ctx.close();
  }
  assert.deepEqual(hidden, []);
  return { ctx: null, errors: [] };
});

test('bienvenida en Android con el aviso de Chrome: «Instalar la app» es el botón principal y «Ahora no» el secundario', async () => {
  const { page, ctx, errors } = await openApp({ state: null, device: 'android', standalone: false, width: 360, height: 740 });
  await page.waitForSelector('.onboarding.open');
  await fakeInstallPrompt(page);
  await page.click('[data-testid="ob-next"]');
  await page.waitForSelector('.ob-step[data-step="name"]');
  await page.click('[data-testid="ob-next"]');
  await page.waitForSelector('.ob-step[data-step="install"] [data-testid="install-prompt"]');
  assert.match(await page.getAttribute('.ob-step [data-testid="install-prompt"]', 'class'), /btn-primary/);
  assert.equal(await text(page, '[data-testid="ob-next"]'), 'Ahora no');
  assert.match(await page.getAttribute('[data-testid="ob-next"]', 'class'), /btn-secondary/);
  // Todo el paso cabe en 360×740 (sin tener que desplazar)
  const fits = await page.evaluate(() => { const c = document.querySelector('.ob-content'); return c.scrollHeight <= c.clientHeight + 1; });
  assert.ok(fits, 'el paso de instalar cabe sin desplazar');
  await page.click('[data-testid="ob-next"]');
  await page.waitForSelector('.ob-step[data-step="reminders"]');
  assert.match(await page.getAttribute('[data-testid="ob-next"]', 'class'), /btn-primary/);
  assert.equal(await text(page, '[data-testid="ob-next"]'), 'Empezar');
  return { ctx, errors };
});

test('Escanear en el ordenador: un solo botón «Elegir fotos del plan» (sin «Tomar foto»)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), device: 'desktop', width: 1280, height: 800, standalone: false });
  await tab(page, 'escanear');
  const labels = await page.locator('#view-escanear .scan-actions label.btn').allInnerTexts();
  assert.deepEqual(labels.map((t) => t.trim()), ['Elegir fotos del plan']);
  assert.equal(await page.getAttribute('#view-escanear .scan-actions label.btn', 'for'), 'scan-pick-input');
  return { ctx, errors };
});

test('diseño a 360 px: las horas lado a lado pasan una debajo de otra (formato de 12 h)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), device: 'android', standalone: false, width: 360, height: 740 });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-13"]');
  await sheetOpen(page);
  await page.click('.sheet-day [data-testid="day-time-edit"]');
  const [a, b] = await page.evaluate(() => ['day-time-start', 'day-time-end'].map((id) => {
    const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect(); return { top: r.top, w: r.width };
  }));
  assert.ok(b.top > a.top + 20, 'una debajo de otra');
  assert.ok(a.w > 250, `campo ancho (${a.w} px)`);
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
