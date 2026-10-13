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
// prefetch: false (por defecto) = sin descargar el lector en segundo plano (ui/prefetch.js)
async function openApp({ state = null, sw = 'block', width = 390, height = 844, hash = '', net = true, standalone = true, ios = true, gh, device, prefetch = false } = {}) {
  const ctx = await iphoneContext(browser, { scale: 1, sw, width, height, ios, device });
  openContexts.push(ctx);
  const errors = [];
  const page = await preparePage(ctx, { state, errors, standalone });
  await page.addInitScript((pf) => { window.__turnosPrefetch = pf; }, prefetch);
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
    await page.addInitScript(() => { window.__turnosPrefetch = false; });
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
  // Su turno no dice de quién es: primero «¿Estos turnos son de Ana?» (sin el «Conectar…» genérico)
  await waitDialog(page, '¿Estos turnos son de Ana?');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /En este teléfono hay 1 día con turnos y no dice de quién son/);
  await clickDialog(page, 'Sí, son de Ana');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await page.waitForSelector('.sheet-subscribe [data-testid="webcal"][aria-disabled="false"]', { timeout: 15000 });
  assert.match(await page.getAttribute('.sheet-subscribe [data-testid="webcal"]', 'href'), /^intent:\/\/raw\.githubusercontent\.com\/[^#]+\/HEAD\/ana\/turnos\.ics#Intent;scheme=webcals;package=at\.bitfire\.icsdroid;/);
  assert.match(await text(page, '[data-testid="subscribe-step"]'), /ICSx⁵[\s\S]*Cada hora/);
  assert.ok(await visible(page, '.sheet-subscribe [data-testid="copy-cal-link"]'), '«Copiar enlace» siempre');
  const s = await getState(page);
  assert.equal(s.settings.sync.dir, 'ana');
  assert.equal(s.settings.name, 'Ana', '«Sí, son de Ana»: su nombre se guarda (no tenía)');
  assert.deepEqual(Object.keys(s.days), ['2026-10-14'], 'su turno se queda');
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

// ---------- 1.4.2 ----------

// Enlace del calendario de Ana (carpeta ana/, su clave)
const anaHash = () => setupHash({ dir: 'ana', key: OTHER_KEY, name: 'Ana' });
const dialogTitle = (page) => text(page, '.dialog-wrap.open .dialog-title');
const openHash = (page, hash) => page.evaluate((hsh) => { location.hash = hsh; }, hash);
// Anota el título de cada diálogo que se abre (window.__titles)
const recordDialogs = (page) => page.evaluate(() => {
  window.__titles = [];
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      for (const t of n.matches?.('.dialog-title') ? [n] : n.querySelectorAll?.('.dialog-title') || []) window.__titles.push(t.textContent.trim());
    }
  }).observe(document.body, { childList: true, subtree: true });
});
const titles = (page) => page.evaluate(() => window.__titles || []);
const waitDialog = (page, title) => page.waitForSelector(`.dialog-wrap.open .dialog-title:text-is(${JSON.stringify(title)})`, { timeout: 15000 });
const clickDialog = (page, label) => page.click(`.dialog-wrap.open .dialog button:text-is(${JSON.stringify(label)})`);

test('otra persona: el enlace de Ana en un teléfono que usa el calendario de Mauricio pregunta; Cancelar no cambia nada', async () => {
  const gh = await familyGitHub();
  const state = core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'android1' } });
  const { page, ctx, errors } = await openApp({ state, gh, device: 'android', standalone: false });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  const before = await getState(page);
  const writes = gh.writes().length;
  await recordDialogs(page);
  await openHash(page, anaHash());
  // Ya usa el calendario de otra persona: sin el «Conectar…» genérico, directamente la pregunta
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Cambiar al calendario de Ana?")', { timeout: 15000 });
  assert.deepEqual(await titles(page), ['¿Cambiar al calendario de Ana?'], 'un solo diálogo');
  const q = await text(page, '.dialog-wrap.open .dialog');
  assert.match(q, /Este enlace es del calendario de Ana y este dispositivo usa el de Mauricio\./, 'el mensaje del core');
  assert.match(q, /¿Cambiar este dispositivo a ese calendario\?/);
  assert.match(q, /se guardan como copia y puedes deshacerlo/);
  assert.doesNotMatch(q, /No se cambió nada/, 'no dice «no se cambió nada» en una pregunta');
  await page.click('.dialog-wrap.open .dialog .btn-secondary');
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  await page.waitForTimeout(500);
  const after = await getState(page);
  assert.equal(after.settings.sync.dir, '', 'sigue en el calendario de Mauricio');
  assert.equal(after.settings.sync.key, KEY);
  assert.deepEqual(Object.keys(after.days).sort(), Object.keys(before.days).sort(), 'los mismos turnos');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('turnos-mauricio:before-import:')).length), 0, 'sin copia: no se cambió nada');
  assert.equal(gh.writes().length, writes, 'nada se escribe en GitHub');
  return { ctx, errors };
});

test('otra persona: confirmar pasa el teléfono al calendario de Ana sin llevar los turnos de Mauricio, y «Deshacer» vuelve', async () => {
  const gh = await familyGitHub();
  const rootBackup = gh.text('backup.json');
  const state = core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'android1' } });
  const { page, ctx, errors } = await openApp({ state, gh, device: 'android', standalone: false });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  const nBefore = Object.keys((await getState(page)).days).length;
  const writes = gh.writes().length;
  await recordDialogs(page);
  await openHash(page, anaHash());
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Cambiar al calendario de Ana?")', { timeout: 15000 });
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  // Ana ya publica desde su teléfono, y este es de Mauricio: no se ofrece tomar el relevo (solo lee)
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  assert.ok(!(await titles(page)).some((t) => /¿Usar este/.test(t)), `sin «¿Usar este…?»: ${await titles(page)}`);
  assert.match(await text(page, '[data-testid="switched-note"]'), /Este teléfono usa ahora «Turnos de Ana»\. Solo lee: ese calendario lo sigue actualizando otro dispositivo\. Si antes te suscribiste al de Mauricio/);
  const s = await getState(page);
  assert.equal(s.settings.sync.dir, 'ana');
  assert.equal(s.settings.sync.key, OTHER_KEY);
  assert.equal(s.settings.name, 'Ana');
  assert.deepEqual(Object.keys(s.days), ['2026-10-14'], 'solo los turnos de Ana');
  assert.equal(gh.writes().length, writes, 'nada de Mauricio se publica en ana/ (ni en la raíz)');
  assert.equal(gh.text('backup.json'), rootBackup);
  // «Deshacer» (dentro del paso «Suscribirme»): vuelve entero al calendario de Mauricio
  assert.equal(await page.locator('.toast:has-text("usa ahora el calendario de Ana")').count(), 0, 'sin aviso que tape la hoja');
  assert.match(await text(page, '[data-testid="switch-undo"]'), /Deshacer: volver al calendario de Mauricio/);
  await page.click('[data-testid="switch-undo"]');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.waitForSelector('.toast:has-text("vuelve al calendario de Mauricio")');
  await waitState(page, (st) => st.settings.sync.dir === '');
  const back = await getState(page);
  assert.equal(back.settings.sync.key, KEY);
  assert.equal(back.settings.name, 'Mauricio');
  assert.equal(Object.keys(back.days).length, nBefore, 'vuelven sus turnos');
  await page.waitForTimeout(300);
  assert.equal(gh.writes().slice(writes).filter((l) => /\/contents\/ana\//.test(l)).length, 0, 'tampoco al deshacer se escribe en ana/');
  return { ctx, errors };
});

test('otra persona: la copia de antes de cambiar sale en «Restaurar» y al recuperarla vuelve a su calendario', async () => {
  const gh = await familyGitHub();
  const state = core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'android1' } });
  const { page, ctx, errors } = await openApp({ state, gh, device: 'android', standalone: false });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  const writes = gh.writes().length;
  await openHash(page, anaHash());
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Cambiar al calendario de Ana?")', { timeout: 15000 });
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await page.click('.sheet-subscribe .sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.click('[data-testid="advanced"] > summary');
  const row = page.locator('#set-restore .set-row', { hasText: 'Copia de antes de cambiar de calendario' });
  assert.match(await row.innerText(), /calendario de Mauricio/);
  await row.locator('[data-testid="restore-copy"]').click();
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Este dispositivo vuelve a ese calendario/);
  await page.click('.dialog-wrap.open .dialog .btn-danger, .dialog-wrap.open .dialog .btn-primary');
  await waitState(page, (st) => st.settings.sync.dir === '' && st.settings.sync.key && Object.keys(st.days).length > 1);
  await page.waitForSelector('.toast:has-text("vuelve al calendario de Mauricio")');
  assert.equal(gh.writes().slice(writes).filter((l) => /\/contents\/ana\//.test(l)).length, 0, 'nada de Mauricio en ana/');
  return { ctx, errors };
});

test('formulario avanzado: cambiar a otro repositorio en un dispositivo con datos de otro calendario pregunta antes; al confirmar no se lleva nada', async () => {
  const gh = await familyGitHub();
  const other = fakeGitHub({ empty: true }); // repositorio nuevo y vacío (p. ej. el de otra persona)
  const state = core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'pc1' } });
  const { page, ctx, errors } = await openApp({ state, gh, device: 'desktop', width: 1280, height: 800, standalone: false });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE' };
  await page.route('https://api.github.com/repos/*/ana-datos**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const r = other.handle({ method: req.method(), url: req.url(), body: req.postData() });
    return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: JSON.stringify(r.body) });
  });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  const nDays = Object.keys((await getState(page)).days).length;
  const writes = gh.writes().length;
  await tab(page, 'ajustes');
  await page.click('[data-testid="advanced"] > summary');
  const ask = async () => {
    await page.fill('[data-fkey="gh-repo"]', 'ana-datos');
    await page.click('[data-fkey="btn-connect"]');
    await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Cambiar de calendario?")', { timeout: 15000 });
    const q = await text(page, '.dialog-wrap.open .dialog');
    assert.match(q, /¿Cambiar este dispositivo a ese calendario\?/);
    assert.doesNotMatch(q, /No se cambió nada/);
  };
  await ask();
  await page.click('.dialog-wrap.open .dialog .btn-secondary');
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  await page.waitForTimeout(300);
  let s = await getState(page);
  assert.equal(s.settings.sync.repo, REPO, 'Cancelar: no cambia de repositorio');
  assert.equal(Object.keys(s.days).length, nDays, 'conserva sus turnos');
  assert.equal(other.writes().length, 0, 'nada en el otro repositorio');
  // Confirmar: el otro calendario empieza limpio (quien ayuda publica primero, sin turnos de Mauricio)
  await ask();
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("Conectado")', { timeout: 15000 });
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  s = await getState(page);
  assert.equal(s.settings.sync.repo, 'ana-datos');
  assert.equal(Object.keys(s.days).length, 0, 'sin los turnos de Mauricio');
  assert.notEqual(s.settings.sync.key, KEY, 'clave nueva para el otro calendario');
  const b = other.json('backup.json');
  assert.ok(b, 'publica en el repositorio nuevo');
  assert.equal(b.meta.days, 0, 'sin ningún turno de Mauricio');
  assert.equal(gh.writes().length, writes, 'el calendario de Mauricio no cambia');
  await page.waitForSelector('.toast:has-text("usa ahora") .toast-action');
  return { ctx, errors };
});

test('datos de otro calendario (sincronización detenida): «Cambiar al calendario conectado…» pregunta y cambia sin llevarlos', async () => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'iphone1', name: 'Mauricio' });
  const rootBackup = gh.text('backup.json');
  // Los turnos de este teléfono son de otro repositorio, pero está configurado con mauricio-datos
  let st = core.updateSettings(core.createDefaultState(), { onboardingDone: true, name: 'Mauricio' });
  st = core.setDay(st, '2026-10-20', ['N1'], { now: new Date('2026-10-01T10:00:00Z') });
  st = core.updateSettings(st, { sync: { ...SYNC, deviceId: 'android1', lastPullAt: '2026-10-10T10:00:00.000Z', boundTarget: `${OWNER.toLowerCase()}/otro-repo/:` } });
  const { page, ctx, errors } = await openApp({ state: st, gh, device: 'android', standalone: false });
  await waitState(page, (s) => s.settings.sync.lastErrorCode === 'OTHER_TARGET');
  assert.equal(gh.text('backup.json'), rootBackup, 'no publica nada');
  await tab(page, 'ajustes');
  await page.waitForSelector('[data-testid="sync-status"][data-kind="error"]');
  await page.click('[data-fkey="btn-switchfix"]');
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Cambiar de calendario?")', { timeout: 15000 });
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /¿Cambiar este dispositivo a ese calendario\?/);
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  // Es el calendario de Mauricio y este teléfono es de Mauricio: se ofrece, con su nombre
  await waitDialog(page, '¿Usar este teléfono para actualizar el calendario de Mauricio?');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Hazlo solo si este es el teléfono de Mauricio\./);
  assert.equal(await text(page, '.dialog-wrap.open .dialog .btn-primary'), 'Sí, usar este', 'recomendado (la misma persona)');
  await clickDialog(page, 'No, solo leer');
  // La dirección del calendario no cambia: no hace falta suscribirse otra vez; «Deshacer» en el aviso
  await page.waitForSelector('.toast:has-text("usa ahora el calendario de Mauricio") .toast-action', { timeout: 15000 });
  const s = await getState(page);
  assert.equal(s.settings.sync.lastErrorCode, null);
  assert.ok(!s.days['2026-10-20'] || s.days['2026-10-20'].codes.join() !== 'N1', 'el N1 del otro calendario no se trae');
  assert.equal(gh.text('backup.json'), rootBackup, 'ni se publica');
  return { ctx, errors };
});

test('«Crear enlace para Mauricio» lleva el nombre: en otro teléfono la confirmación dice «para Mauricio»', async () => {
  const gh = fakeGitHub();
  const state = core.updateSettings(demoState(), { name: 'Mauricio Ducuara', sync: { ...SYNC, deviceId: 'iphone1' } });
  const A = await openApp({ state, gh });
  await waitState(A.page, (s) => Boolean(s.settings.sync.lastPushAt));
  await tab(A.page, 'ajustes');
  await A.page.click('[data-testid="advanced"] > summary');
  await A.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  assert.match(await text(A.page, '[data-testid="make-link"]'), /Crear enlace para Mauricio/);
  await A.page.click('[data-testid="make-link"]');
  await A.page.waitForSelector('.toast:has-text("Enlace copiado")');
  const link = await A.page.evaluate(() => navigator.clipboard.readText());
  const cfg = core.parseSetupLink(link.slice(link.indexOf('#')));
  assert.equal(cfg.name, 'Mauricio', 'solo el nombre de pila');
  assert.equal(cfg.dir, '');
  const B = await openApp({ state: null, gh, hash: link.slice(APP.length), device: 'android', standalone: false });
  await B.page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(B.page, '.dialog-wrap.open .dialog'), /lo preparó quien te ayuda para Mauricio/);
  return { ctx: B.ctx, errors: [...A.errors, ...B.errors] };
});

test('primer uso en el ordenador: «¿De quién son estos turnos?» (no «¿Cómo te llamas?») y sin saludo con nombre', async () => {
  const { page, ctx, errors } = await openApp({ device: 'desktop', width: 1280, height: 800, standalone: false });
  await page.waitForSelector('.onboarding.open');
  await page.click('[data-testid="ob-next"]');
  const step = await text(page, '.ob-step[data-step="name"]');
  assert.match(step, /¿De quién son estos turnos\?/);
  assert.match(step, /escribe el nombre de esa persona, no el tuyo/);
  assert.match(step, /Nombre de la persona[\s\S]*¿Cómo sale su nombre en el plan\?/);
  assert.doesNotMatch(step, /¿Cómo te llamas\?/);
  await page.fill('[data-testid="ob-name"]', 'Mauricio');
  await page.click('[data-testid="ob-next"]');
  await page.click('.ob-skip');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  assert.equal((await getState(page)).settings.name, 'Mauricio');
  await tab(page, 'ajustes');
  assert.match(await text(page, '#set-name'), /Nombre de la persona[\s\S]*no el tuyo, si la ayudas/i);
  return { ctx, errors };
});

test('quien ayuda: un error que no se arregla solo se muestra y no dice «Conectado»', async () => {
  const gh = fakeGitHub({ empty: true });
  const helperState = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  const { page, ctx, errors } = await openApp({ state: helperState, device: 'desktop', width: 1280, height: 800, standalone: false, gh });
  // El token solo puede leer: el PUT da 403
  await page.route('https://api.github.com/**', (r) => (r.request().method() === 'PUT'
    ? r.fulfill({ status: 403, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"message":"Resource not accessible by personal access token"}' })
    : r.fallback()));
  await tab(page, 'ajustes');
  await page.click('[data-testid="advanced"] > summary');
  await page.fill('[data-fkey="gh-owner"]', OWNER);
  await page.fill('[data-fkey="gh-repo"]', REPO);
  await page.fill('[data-fkey="gh-token"]', TOKEN);
  await page.click('[data-fkey="btn-connect"]');
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("Falta un detalle")', { timeout: 15000 });
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.dialog-wrap.open .dialog-title:text("Conectado")').count(), 0, 'sin «Conectado»');
  assert.equal(await page.locator('[data-testid="make-link"]').count(), 0, 'no hay enlace que crear');
  return { ctx, errors: errors.filter((e) => !/403/.test(e)) };
});

test('quien ayuda sin internet: «Se conectará cuando haya internet» y nunca pregunta «¿Usar este dispositivo?»', async () => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'iphone1' });
  // El ordenador de quien ayuda ya tiene la conexión (con la clave) pero nunca llegó a leer: GitHub no responde
  const helperState = core.updateSettings(core.createDefaultState(), { onboardingDone: true, sync: { ...SYNC, deviceId: 'pc1' } });
  gh.status = 503;
  const { page, ctx, errors } = await openApp({ state: helperState, device: 'desktop', width: 1280, height: 800, standalone: false, gh });
  await waitState(page, (s) => s.settings.sync.lastErrorCode === 'SERVER');
  const offline = (r) => r.abort('internetdisconnected');
  await page.route('https://api.github.com/**', offline);
  gh.status = 200;
  await tab(page, 'ajustes');
  await page.click('[data-testid="advanced"] > summary');
  await page.click('[data-fkey="btn-connect"]'); // «Guardar y conectar» otra vez, sin internet
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("Guardado, sin conexión")', { timeout: 15000 });
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Se conectará cuando haya internet; luego podrás crear el enlace/);
  await page.click('.dialog-wrap.open .dialog .btn-primary');
  assert.equal(await page.evaluate(() => localStorage.getItem('turnos-mauricio:ask-takeover')), null, 'quien ayuda no deja pendiente «¿Usar este dispositivo?»');
  assert.equal(await page.locator('[data-testid="make-link"]').count(), 0, 'todavía no se puede crear el enlace');
  // Vuelve internet: publica el iPhone, este solo lee y no pregunta nada
  await page.unroute('https://api.github.com/**', offline);
  await page.evaluate(() => window.__turnosTest.background().syncNow());
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.dialog-wrap.open').count(), 0, 'no pregunta «¿Usar este dispositivo?»');
  assert.equal((await getState(page)).settings.sync.publisher, 'iphone1', 'sigue publicando el iPhone');
  assert.equal(gh.writes().length, 2, 'quien ayuda no escribe nada');
  await page.waitForSelector('[data-testid="make-link"]');
  return { ctx, errors: errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|503/.test(e)) };
});

test('«Crear enlace» no sale si este dispositivo no puede leer el calendario (clave que no vale)', async () => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'iphone1', key: OTHER_KEY });
  const state = core.updateSettings(demoState(), { sync: { ...SYNC, deviceId: 'pc1', lastPullAt: '2026-10-12T08:00:00.000Z' } });
  const { page, ctx, errors } = await openApp({ state, gh, device: 'desktop', width: 1280, height: 800, standalone: false });
  await waitState(page, (s) => s.settings.sync.lastErrorCode === 'DECRYPT');
  await tab(page, 'ajustes');
  await page.click('[data-testid="advanced"] > summary');
  assert.equal(await page.locator('[data-testid="make-link"]').count(), 0);
  assert.match(await text(page, '[data-testid="make-link-blocked"]'), /no está disponible[\s\S]*la clave no vale/);
  return { ctx, errors };
});

test('Horas: lo acreditado dice vacaciones y enfermedad por separado', async () => {
  let state = demoState();
  const at = new Date('2026-10-12T10:00:00Z');
  state = core.setDay(state, '2026-10-20', ['U'], { now: at });
  state = core.setDay(state, '2026-10-21', ['K'], { now: at });
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'horas');
  assert.match(await text(page, '.hs-foot'), /Incluye 7 h de vacaciones y 7 h de enfermedad\./);
  state = core.clearDay(state, '2026-10-20', { now: at });
  const B = await openApp({ state });
  await tab(B.page, 'horas');
  assert.match(await text(B.page, '.hs-foot'), /Incluye 7 h de enfermedad\./);
  assert.doesNotMatch(await text(B.page, '.hs-foot'), /vacaciones/);
  return { ctx: B.ctx, errors: [...errors, ...B.errors] };
});

test('revisión: «Esta hoja parece de otra persona» es un aviso naranja (no informativo)', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  const w = 'Esta hoja parece de otra persona: no veo «Ana» en el nombre. Revisa antes de guardar.';
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), {
    layout: 'pc-table', month: 11, year: 2026, days: [{ day: 2, codes: ['F1'], confidence: 0.4 }, { day: 3, codes: ['S1'], confidence: 0.4 }],
    warnings: [w, 'Otro aviso.'],
  });
  await page.waitForSelector('.review-list');
  const warn = page.locator('[data-testid="other-sheet"]');
  assert.equal(await warn.count(), 1);
  assert.match(await warn.getAttribute('class'), /notice-warn/);
  assert.equal(await warn.innerText(), w);
  assert.equal(await page.locator('.notice-info', { hasText: 'Esta hoja parece' }).count(), 0);
  assert.equal(await page.locator('.notice-info', { hasText: 'Otro aviso.' }).count(), 1, 'los demás avisos siguen siendo informativos');
  return { ctx, errors };
});

test('360 px: «Desde» (mes) y «En el plan» ponen el campo debajo del texto, sin cortar «Ducuara Mauricio»', async () => {
  const state = core.updateSettings(demoState(), { name: 'Mauricio', planName: 'Ducuara Mauricio', balances: { overtimeStartMonth: '2026-09' } });
  const { page, ctx, errors } = await openApp({ state, device: 'android', standalone: false, width: 360, height: 740 });
  await tab(page, 'ajustes');
  await page.click('[data-testid="payroll"] > summary');
  const m = await page.evaluate(() => {
    const geo = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width }; };
    const plan = document.querySelector('[data-fkey="planName"]');
    const month = document.querySelector('[data-fkey="ot-month"]');
    const planLabel = plan.closest('.set-row').querySelector('.set-row-main');
    const monthLabel = month.closest('.set-row').querySelector('.set-row-main');
    return { plan: geo(plan), planLabel: geo(planLabel), planFits: plan.scrollWidth <= plan.clientWidth + 1, month: geo(month), monthLabel: geo(monthLabel) };
  });
  assert.ok(m.plan.top >= m.planLabel.bottom - 1, 'el campo del plan va debajo');
  assert.ok(m.plan.w > 230, `campo del plan ancho (${m.plan.w})`);
  assert.ok(m.planFits, '«Ducuara Mauricio» cabe entero');
  assert.ok(m.month.top >= m.monthLabel.bottom - 1, 'el mes va debajo de «Desde»');
  assert.ok(m.monthLabel.w > 250, `el texto de «Desde» no se aprieta (${m.monthLabel.w})`);
  assert.deepEqual(await findOverflow(page), []);
  return { ctx, errors };
});

test('PWA: el lector se descarga en segundo plano y el primer escaneo funciona SIN NINGUNA conexión', async () => {
  // Servidor propio delante del estático (para apagarlo) que anota lo que le llega
  const hits = [];
  const sockets = new Set();
  const proxy = http.createServer(async (req, res) => {
    hits.push(req.url);
    try {
      const r = await fetch(server.url + req.url);
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(502).end(); }
  });
  proxy.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  // Que las rutas y el modo sin conexión de Playwright lleguen también a las peticiones del service worker
  const prevFlag = process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS;
  process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
  try {
    const ctx = await iphoneContext(browser, { scale: 1, sw: 'allow' });
    openContexts.push(ctx);
    const errors = [];
    const page = await preparePage(ctx, { state: core.updateSettings(core.createDefaultState(), { onboardingDone: true }), errors, standalone: true });
    await page.addInitScript(() => { window.__turnosPrefetch = { delay: 300 }; });
    const base = `http://127.0.0.1:${proxy.address().port}/docs/`;
    await page.goto(base);
    await page.waitForSelector('.tabbar');
    // Descarga en segundo plano (sin escanear nada)
    await page.waitForFunction(() => window.__turnosTest.prefetch()?.status().status === 'done', null, { timeout: 60000 });
    const files = await page.evaluate(() => window.__turnosTest.prefetch().files());
    assert.equal(files.length, 4, `un solo núcleo (el de este dispositivo): ${files.join(', ')}`);
    assert.ok(files.some((f) => /core\/tesseract-core-[a-z]*-?lstm\.wasm\.js$/.test(f)));
    assert.ok(files.some((f) => f.endsWith('lang/best_int/eng.traineddata.gz')));
    assert.equal(await page.evaluate(() => typeof window.Tesseract), 'undefined', 'no se ejecutó el lector: solo se descargó');
    const cached = await page.evaluate(async () => {
      const name = (await caches.keys()).find((k) => k.startsWith('turnos-vendor-'));
      return { name, urls: (await (await caches.open(name)).keys()).map((r) => r.url) };
    });
    for (const f of files) assert.ok(cached.urls.includes(f), `en la caché ${cached.name}: ${f}`);
    const others = ['simd', 'relaxedsimd', ''].map((v) => `core/tesseract-core-${v ? `${v}-` : ''}lstm.wasm.js`).filter((c) => !files.some((f) => f.endsWith(c)));
    assert.equal(others.length, 2);
    assert.ok(!cached.urls.some((u) => others.some((c) => u.endsWith(c))), 'los otros núcleos no se descargan');
    // Sin conexión de verdad: rutas abortadas (también las del service worker) + sin conexión + servidor apagado
    await ctx.route('**', (r) => r.abort('internetdisconnected'));
    await ctx.setOffline(true);
    // Comprobación: una petición que el service worker manda a la red (no está en su caché) no llega
    const before = hits.length;
    const probe = await page.evaluate(async () => {
      try { const r = await fetch('vendor/tesseract/no-esta-en-cache.js?sonda'); return `respuesta ${r.status}`; } catch (e) { return 'error'; }
    });
    assert.equal(probe, 'error', 'la petición del service worker a la red falla');
    assert.equal(hits.slice(before).filter((u) => /sonda/.test(u)).length, 0, 'el bloqueo llega a las peticiones del service worker');
    for (const s of sockets) s.destroy();
    await new Promise((r) => proxy.close(r));
    // Abrir otra vez la app y escanear por primera vez, sin red
    await page.reload();
    await page.waitForSelector('.tabbar');
    const hitsOffline = hits.length;
    await tab(page, 'escanear');
    await page.setInputFiles('input[data-testid="scan-pick"]', PHOTO);
    await page.waitForSelector('.review-list, .fallback, [data-testid="ocr-failed"]', { timeout: 90000 });
    assert.equal(await page.locator('[data-testid="ocr-failed"]').count(), 0, 'el lector arranca sin conexión');
    assert.ok(await page.locator('.review-list').count() > 0, 'llega a la revisión');
    assert.match(await text(page, '.review-month'), /Octubre/i);
    assert.equal(hits.length, hitsOffline, 'nada llegó al servidor');
    return { ctx, errors: errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_FAILED|Failed to fetch|no-esta-en-cache/.test(e)) };
  } finally {
    if (prevFlag === undefined) delete process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS;
    else process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = prevFlag;
    for (const s of sockets) s.destroy();
    proxy.close();
  }
}, { slow: true });

// ---------- 1.4.3 ----------

// Teléfono de Ana con sus turnos (ANA-MARK), nunca conectado. name '' = saltó «¿Cómo te llamas?»
function anaPhoneState(name = '') {
  let st = core.updateSettings(core.createDefaultState(), { onboardingDone: true, name });
  st = core.setDay(st, '2026-10-15', ['N1'], { now: new Date('2026-10-12T10:00:00Z') });
  st = core.setDay(st, '2026-12-24', ['N1'], { note: 'ANA-MARK', now: new Date('2026-10-12T10:00:00Z') });
  return st;
}
const copiesIn = (page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('turnos-mauricio:before-import:')).length);
const mauState = () => core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'iphone1' } });

test('S2b: teléfono sin nombre y con turnos abre el enlace de Mauricio: «¿Estos turnos son de Mauricio?»; «No» → cancelar o cambiar limpio', async () => {
  const gh = await familyGitHub();
  const rootBackup = gh.text('backup.json');
  const { page, ctx, errors } = await openApp({ state: anaPhoneState(), gh, device: 'android', standalone: false });
  await recordDialogs(page);
  const writes = gh.writes().length;
  const link = setupHash({ name: 'Mauricio' });
  await openHash(page, link);
  await waitDialog(page, '¿Estos turnos son de Mauricio?');
  assert.deepEqual(await titles(page), ['¿Estos turnos son de Mauricio?'], 'lo primero: de quién son (sin «Conectar…» ni «¿Usar este…?»)');
  const q = await text(page, '.dialog-wrap.open .dialog');
  assert.match(q, /En este teléfono hay 2 días con turnos y no dice de quién son\. El enlace es del calendario de Mauricio: si son de Mauricio, se juntan con su calendario\. Si son de otra persona, toca «No» y no se junta nada\./);
  await clickDialog(page, 'No');
  await waitDialog(page, '¿Cambiar este teléfono al calendario de Mauricio?');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /no se juntan con los de Mauricio[\s\S]*se guardan como copia y puedes deshacerlo[\s\S]*pide el correcto/);
  await clickDialog(page, 'Cancelar');
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  await page.waitForTimeout(300);
  let s = await getState(page);
  assert.deepEqual([s.settings.sync.enabled, s.settings.name, Object.keys(s.days).sort()], [false, '', ['2026-10-15', '2026-12-24']], 'Cancelar: nada cambia');
  assert.equal(await copiesIn(page), 0, 'sin copia sobrante');
  assert.equal(gh.writes().length, writes);
  // Otra vez: «No» → «Sí, cambiar»: solo lo de Mauricio, y no se ofrece tomar el relevo
  await page.evaluate(() => { location.hash = ''; });
  await openHash(page, link);
  await waitDialog(page, '¿Estos turnos son de Mauricio?');
  await clickDialog(page, 'No');
  await waitDialog(page, '¿Cambiar este teléfono al calendario de Mauricio?');
  await clickDialog(page, 'Sí, cambiar');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  assert.ok(!(await titles(page)).some((t) => /¿Usar este/.test(t)), `sin «¿Usar este…?»: ${await titles(page)}`);
  assert.match(await text(page, '[data-testid="switched-note"]'), /Solo lee: ese calendario lo sigue actualizando otro dispositivo/);
  s = await getState(page);
  assert.equal(s.settings.sync.dir, '');
  assert.ok(!s.days['2026-12-24'] && s.days['2026-10-15']?.codes.join() !== 'N1', 'sin los turnos de Ana');
  assert.equal(s.settings.name, 'Mauricio');
  assert.equal(gh.text('backup.json'), rootBackup, 'el calendario de Mauricio no cambia');
  assert.equal(gh.writes().length, writes, 'nada se escribe');
  // «Restaurar»: la copia de antes (sin conectar) lo dice
  await page.click('.sheet-subscribe .sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.click('[data-testid="advanced"] > summary');
  const row = page.locator('#set-restore .set-row', { hasText: 'Copia de antes de cambiar de calendario' });
  assert.match(await row.innerText(), /2 días \(sin conectar\)/);
  await row.locator('[data-testid="restore-copy"]').click();
  await waitDialog(page, '¿Volver a esta copia?');
  const r = await text(page, '.dialog-wrap.open .dialog');
  assert.match(r, /con 2 días \(sin conectar\)\. Este dispositivo vuelve a como estaba \(sin conectar\) y deja el calendario de ahora\./);
  assert.doesNotMatch(r, /vuelve a ese calendario|Ojo/);
  await clickDialog(page, 'Volver a esta copia');
  await waitState(page, (x) => Boolean(x.days['2026-12-24']) && x.settings.sync.enabled === false && x.settings.name === '');
  await page.waitForTimeout(800);
  assert.equal(gh.writes().length, writes, 'tampoco al volver');
  return { ctx, errors };
});

test('S2b: «Sí, son de Mauricio» → «¿Usar este teléfono para actualizar el calendario de Mauricio?… Hazlo solo si…»; «No, solo leer» no publica', async () => {
  const gh = await familyGitHub();
  const rootBackup = gh.text('backup.json');
  const { page, ctx, errors } = await openApp({ state: anaPhoneState(), gh, device: 'android', standalone: false });
  const writes = gh.writes().length;
  await openHash(page, setupHash({ name: 'Mauricio' }));
  await waitDialog(page, '¿Estos turnos son de Mauricio?');
  await clickDialog(page, 'Sí, son de Mauricio');
  await waitDialog(page, '¿Usar este teléfono para actualizar el calendario de Mauricio?');
  const q = await text(page, '.dialog-wrap.open .dialog');
  assert.match(q, /Hazlo solo si este es el teléfono de Mauricio\./);
  assert.doesNotMatch(q, /Recomendado si este es tu/);
  await clickDialog(page, 'No, solo leer');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  const s = await getState(page);
  assert.equal(s.settings.name, 'Mauricio', '«Sí»: el teléfono es de Mauricio');
  assert.ok(s.days['2026-12-24'], 'sus turnos se quedan aquí');
  assert.equal(gh.text('backup.json'), rootBackup, 'solo lee');
  assert.equal(gh.writes().length, writes);
  return { ctx, errors };
});

test('el teléfono de Ana (con nombre, sin turnos) abre el enlace de Mauricio: tomar el relevo no se recomienda («No, solo leer» primero)', async () => {
  const gh = await familyGitHub({ ana: false });
  const rootBackup = gh.text('backup.json');
  const st = core.updateSettings(core.createDefaultState(), { onboardingDone: true, name: 'Ana' });
  const { page, ctx, errors } = await openApp({ state: st, gh, device: 'android', standalone: false });
  await openHash(page, setupHash({ name: 'Mauricio' }));
  await waitDialog(page, 'Conectar el calendario del teléfono');
  await clickDialog(page, 'Sí, conectar');
  await waitDialog(page, '¿Usar este teléfono para actualizar el calendario de Mauricio?');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Hazlo solo si este es el teléfono de Mauricio\./);
  assert.deepEqual(await page.locator('.dialog-wrap.open .dialog-actions button').allInnerTexts(), ['No, solo leer', 'Sí, usar este']);
  assert.equal(await text(page, '.dialog-wrap.open .dialog .btn-primary'), 'No, solo leer');
  await clickDialog(page, 'No, solo leer');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  assert.equal(gh.text('backup.json'), rootBackup);
  return { ctx, errors };
});

test('S1: el iPhone de Mauricio cambia al calendario de Ana: no se ofrece tomar el relevo y «Deshacer» deja ana/ con su teléfono publicando', async () => {
  const gh = await familyGitHub();
  const anaBefore = gh.text('ana/backup.json');
  const { page, ctx, errors } = await openApp({ state: mauState(), gh, standalone: true });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  await recordDialogs(page);
  const writes = gh.writes().length;
  await openHash(page, anaHash());
  await waitDialog(page, '¿Cambiar al calendario de Ana?');
  await clickDialog(page, 'Sí, cambiar');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  assert.deepEqual(await titles(page), ['¿Cambiar al calendario de Ana?'], 'ni «Conectar…» ni «¿Usar este iPhone…?»');
  const s = await getState(page);
  assert.deepEqual([s.settings.sync.dir, s.settings.sync.publisher, s.settings.sync.key], ['ana', 'android-ana', OTHER_KEY]);
  await page.click('[data-testid="switch-undo"]');
  await waitState(page, (x, k) => x.settings.sync.dir === '' && x.settings.sync.key === k, KEY);
  await page.evaluate(() => window.__turnosTest.background().runSync({ manual: true, force: true }));
  await page.waitForTimeout(1200);
  assert.equal(gh.text('ana/backup.json'), anaBefore, 'ana/ sigue igual');
  assert.equal(gh.json('ana/backup.json').meta.publisher, 'android-ana', 'lo sigue publicando el teléfono de Ana');
  assert.equal(gh.writes().slice(writes).filter((l) => /\/contents\/ana\//.test(l)).length, 0, 'nada se escribe en ana/');
  return { ctx, errors };
});

test('S1b: tras cambiar al calendario de Ana, «Usar este dispositivo» lo nombra y «Restaurar» avisa de que dejará de actualizarse', async () => {
  const gh = await familyGitHub();
  const { page, ctx, errors } = await openApp({ state: mauState(), gh, standalone: true });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  await openHash(page, anaHash());
  await waitDialog(page, '¿Cambiar al calendario de Ana?');
  await clickDialog(page, 'Sí, cambiar');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await page.click('.sheet-subscribe .sheet-close');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.click('[data-testid="takeover"]');
  await waitDialog(page, '¿Actualizar el calendario de Ana desde este iPhone?');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Hazlo solo si este es el iPhone de Ana\./);
  await clickDialog(page, 'Sí, usar este');
  await page.waitForSelector('.toast:has-text("ahora el calendario se actualiza desde aquí")', { timeout: 15000 });
  assert.equal(gh.json('ana/backup.json').meta.publisher, 'iphone1');
  await page.click('[data-testid="advanced"] > summary');
  const row = page.locator('#set-restore .set-row', { hasText: 'Copia de antes de cambiar de calendario' });
  await row.locator('[data-testid="restore-copy"]').click();
  await waitDialog(page, '¿Volver a esta copia?');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /\(calendario de Mauricio\)\. Este dispositivo vuelve a ese calendario y deja el de ahora\. Ojo: este iPhone actualiza ahora el calendario de Ana: dejará de actualizarse hasta que otro dispositivo toque «Usar este dispositivo»\./);
  await clickDialog(page, 'Cancelar');
  return { ctx, errors };
});

test('misma persona en otra carpeta: tras cambiar se ofrece el relevo con su nombre (recomendado) y «Deshacer» recuerda «Usar este dispositivo»', async () => {
  const gh = await familyGitHub({ ana: false });
  const MKEY = Buffer.alloc(32, 5).toString('base64url');
  // Quien ayuda preparó otra carpeta para Mauricio y la publica desde su ordenador (vacía)
  await seedRemote(gh, core.updateSettings(core.createDefaultState(), { onboardingDone: true }), { deviceId: 'pc1', dir: 'mauricio', key: MKEY, name: 'Mauricio' });
  const { page, ctx, errors } = await openApp({ state: mauState(), gh, standalone: true });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  await openHash(page, setupHash({ dir: 'mauricio', key: MKEY, name: 'Mauricio' }));
  await waitDialog(page, '¿Cambiar de calendario?');
  await clickDialog(page, 'Sí, cambiar');
  await waitDialog(page, '¿Usar este iPhone para actualizar el calendario de Mauricio?');
  assert.equal(await text(page, '.dialog-wrap.open .dialog .btn-primary'), 'Sí, usar este', 'recomendado: la misma persona');
  await clickDialog(page, 'Sí, usar este');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await waitState(page, (x) => x.settings.sync.dir === 'mauricio' && x.settings.sync.publisher === x.settings.sync.deviceId);
  assert.equal(gh.json('mauricio/backup.json').meta.publisher, 'iphone1');
  await page.click('[data-testid="switch-undo"]');
  await page.waitForSelector('.toast:has-text("ya no se actualiza desde aquí: en el dispositivo que lo usa, toca «Usar este dispositivo»")', { timeout: 10000 });
  await waitState(page, (x) => x.settings.sync.dir === '');
  return { ctx, errors };
});

test('S2c: enlace antiguo sin nombre y copia de la raíz sin meta.name: el nombre sale del calendario publicado («Turnos de Mauricio»)', async () => {
  const gh = await familyGitHub({ ana: false });
  const doc = gh.json('backup.json');
  delete doc.meta.name; // como una copia de 1.4.1 (no va en los datos autenticados)
  gh.write('backup.json', JSON.stringify(doc));
  assert.match(gh.text('turnos.ics'), /X-WR-CALNAME:Turnos de Mauricio/);
  const { page, ctx, errors } = await openApp({ state: anaPhoneState('Ana'), gh, device: 'android', standalone: false });
  const writes = gh.writes().length;
  await openHash(page, setupHash());
  await waitDialog(page, 'Conectar el calendario del teléfono'); // el enlace no dice de quién es
  await clickDialog(page, 'Sí, conectar');
  await waitDialog(page, '¿Cambiar al calendario de Mauricio?');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Este enlace es del calendario de Mauricio y en este dispositivo hay turnos de Ana\./);
  await clickDialog(page, 'Cancelar');
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  await page.waitForTimeout(300);
  const s = await getState(page);
  assert.equal(s.settings.sync.enabled, false);
  assert.ok(s.days['2026-12-24']);
  assert.equal(gh.writes().length, writes);
  return { ctx, errors };
});

test('S3b: quien ayuda cambia de rama en el formulario: no se pregunta ni se crea la rama; recomienda «Crear enlace para otra persona»', async () => {
  const gh = await familyGitHub({ ana: false });
  const helper = core.updateSettings(core.createDefaultState(), { onboardingDone: true, name: 'Mauricio', sync: { ...SYNC, deviceId: 'pc1' } });
  const { page, ctx, errors } = await openApp({ state: helper, gh, device: 'desktop', width: 1280, height: 800, standalone: false });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt) && Object.keys(s.days).length > 5);
  await recordDialogs(page);
  const writes = gh.writes().length;
  const nDays = Object.keys((await getState(page)).days).length;
  await tab(page, 'ajustes');
  await page.click('[data-testid="advanced"] > summary');
  await page.fill('[data-fkey="gh-branch"]', 'datos');
  await page.click('[data-fkey="btn-connect"]');
  await waitDialog(page, 'No se pudo conectar');
  assert.match(await text(page, '.dialog-wrap.open .dialog'), /Esa rama todavía no existe[\s\S]*usa «Crear enlace para otra persona» \(le crea su carpeta\)\. No se cambió nada\./);
  assert.deepEqual(await titles(page), ['No se pudo conectar'], 'sin «¿Cambiar de calendario?» antes');
  await clickDialog(page, 'Entendido');
  const s = await getState(page);
  assert.deepEqual([s.settings.sync.branch, Object.keys(s.days).length], ['', nDays], 'nada cambia');
  assert.equal(gh.branches.datos, undefined, 'la rama no se creó');
  assert.equal(gh.writes().length, writes, 'nada se escribe');
  assert.equal(await copiesIn(page), 0);
  return { ctx, errors: errors.filter((e) => !/404/.test(e)) };
});

test('sin internet, un enlace de otro calendario en un teléfono conectado: «no se cambió nada… Abre el enlace otra vez»', async () => {
  const gh = await familyGitHub();
  const { page, ctx, errors } = await openApp({ state: mauState(), gh, standalone: true });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt));
  const before = await getState(page);
  await page.route('https://api.github.com/**', (r) => r.abort('internetdisconnected'));
  await openHash(page, anaHash());
  await waitDialog(page, 'No se pudo conectar');
  assert.equal(await text(page, '.dialog-wrap.open .dialog-text'), 'Sin conexión a internet: no se cambió nada. Abre el enlace otra vez cuando tengas internet.');
  await clickDialog(page, 'Entendido');
  const after = await getState(page);
  assert.deepEqual([after.settings.sync.dir, after.settings.sync.key, Object.keys(after.days).length], ['', KEY, Object.keys(before.days).length]);
  assert.equal(await copiesIn(page), 0);
  return { ctx, errors: errors.filter((e) => !/INTERNET_DISCONNECTED|Failed to fetch/.test(e)) };
});

test('quien ayuda vuelve por el formulario a un calendario sin su clave: el aviso explica «Restaurar → Copia de antes de cambiar de calendario»', async () => {
  const gh = await familyGitHub({ ana: false });
  const other = fakeGitHub({ empty: true });
  const helper = core.updateSettings(core.createDefaultState(), { onboardingDone: true, name: 'Mauricio', sync: { ...SYNC, deviceId: 'pc1' } });
  const { page, ctx, errors } = await openApp({ state: helper, gh, device: 'desktop', width: 1280, height: 800, standalone: false });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,PUT,POST,DELETE' };
  await page.route('https://api.github.com/repos/*/ana-datos**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const r = other.handle({ method: req.method(), url: req.url(), body: req.postData() });
    return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: JSON.stringify(r.body) });
  });
  await waitState(page, (s) => Boolean(s.settings.sync.lastPullAt) && Object.keys(s.days).length > 5);
  await tab(page, 'ajustes');
  await page.click('[data-testid="advanced"] > summary');
  await page.fill('[data-fkey="gh-repo"]', 'ana-datos');
  await page.click('[data-fkey="btn-connect"]');
  await waitDialog(page, '¿Cambiar de calendario?');
  await clickDialog(page, 'Sí, cambiar');
  await waitDialog(page, 'Conectado');
  await clickDialog(page, 'Entendido');
  await waitState(page, (s) => s.settings.sync.repo === 'ana-datos');
  await page.fill('[data-fkey="gh-repo"]', REPO);
  await page.click('[data-fkey="btn-connect"]');
  await waitDialog(page, 'No se pudo conectar');
  const msg = await text(page, '.dialog-wrap.open .dialog-text');
  assert.match(msg, /^Falta la clave para leer tus turnos guardados en internet\. No se envió nada\. Para volver a un calendario que ya usabas aquí: Opciones avanzadas → Restaurar → «Copia de antes de cambiar de calendario», o abre aquí el enlace del teléfono que lo publica\.$/);
  assert.doesNotMatch(msg, /Pide ayuda a quien te configuró/);
  await clickDialog(page, 'Entendido');
  return { ctx, errors: errors.filter((e) => !/404|409/.test(e)) };
});

test('PWA: si empieza un escaneo mientras se descarga el lector, se corta la descarga en curso (y se reintenta luego)', async () => {
  // Servidor delante del estático: el diccionario (eng.traineddata.gz) tarda en llegar
  const sockets = new Set();
  const proxy = http.createServer(async (req, res) => {
    try {
      const r = await fetch(server.url + req.url);
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': body.length });
      if (!/eng\.traineddata/.test(req.url)) { res.end(body); return; }
      res.write(body.subarray(0, 1024));
      setTimeout(() => { try { res.end(body.subarray(1024)); } catch { /* cortado */ } }, 15000);
    } catch { res.writeHead(502).end(); }
  });
  proxy.on('connection', (sk) => { sockets.add(sk); sk.on('close', () => sockets.delete(sk)); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const ctx = await iphoneContext(browser, { scale: 1, sw: 'allow' });
    openContexts.push(ctx);
    const errors = [];
    const page = await preparePage(ctx, { state: core.updateSettings(core.createDefaultState(), { onboardingDone: true }), errors, standalone: true });
    await page.addInitScript(() => { window.__turnosPrefetch = false; });
    await page.goto(`http://127.0.0.1:${proxy.address().port}/docs/`);
    await page.waitForSelector('.tabbar');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 20000 });
    await page.evaluate(async () => {
      const { createOcrPrefetch } = await import('./js/ui/prefetch.js');
      window.__busy = false;
      window.__pf = createOcrPrefetch({ isBusy: () => window.__busy });
      window.__pf.run();
    });
    // Ya bajó el lector y su núcleo; el diccionario está a medias
    await page.waitForFunction(() => window.__pf.status().status === 'running' && window.__pf.status().fetched.length === 3, null, { timeout: 60000 });
    await page.evaluate(() => { window.__busy = true; }); // empieza un escaneo
    await page.waitForFunction(() => window.__pf.status().aborted === 1, null, { timeout: 5000 });
    const st = await page.evaluate(() => window.__pf.status());
    assert.equal(st.status, 'waiting', 'se aplaza (se reintenta luego)');
    assert.equal(st.error, null);
    const cached = await page.evaluate(async () => Boolean(await caches.match(window.__pf.files().find((f) => f.endsWith('eng.traineddata.gz')))));
    assert.equal(cached, false, 'el diccionario a medias no queda en la caché');
    return { ctx, errors: errors.filter((e) => !/abort/i.test(e)) };
  } finally {
    for (const sk of sockets) sk.destroy();
    proxy.close();
  }
}, { slow: true });

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
