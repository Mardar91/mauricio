// Tests de interfaz con Playwright (Chromium, pantalla tipo iPhone). Uso: npm run e2e [-- filtro]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/serve.mjs';
import {
  ROOT, STORAGE_KEY, core, demoState, ensureOut, findOverflow, iphoneContext, mockNetwork, preparePage,
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

// Abre la app con un estado inicial; devuelve { page, ctx, errors, net }
async function openApp({ state = null, sw = 'block', width = 390, hash = '', net = true } = {}) {
  const ctx = await iphoneContext(browser, { scale: 1, sw, width });
  openContexts.push(ctx);
  const errors = [];
  const page = await preparePage(ctx, { state, errors });
  const log = net ? await mockNetwork(page) : null;
  await page.goto(APP + hash);
  await page.waitForSelector('.tabbar');
  return { page, ctx, errors, net: log };
}

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

test('primer uso: completar la bienvenida (con paso de instalación en iOS) lleva a Escanear', async () => {
  const { page, ctx, errors } = await openApp();
  await page.waitForSelector('.onboarding.open');
  const steps = await page.locator('.ob-dot').count();
  assert.equal(steps, 3, 'en iPhone (Safari) se muestra el paso de instalar');
  for (let i = 0; i < steps; i++) await page.click('.ob-bottom .btn-primary');
  await page.waitForSelector('.onboarding', { state: 'detached' });
  assert.ok(await visible(page, '#view-escanear'));
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
  await page.click('.sheet-day .btn-primary');
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
  await page.click('.dialog .btn-danger');
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
  assert.match(await text(page, '.fallback'), /No he podido leer la foto/);
  assert.equal(await page.evaluate(() => typeof window.Tesseract), 'object', 'tesseract.min.js cargado antes de reconocer');
  await page.selectOption('.fallback .month-picker select >> nth=0', '10');
  await page.selectOption('.fallback .month-picker select >> nth=1', '2026');
  await page.click('.fallback-card .btn-primary');
  await page.waitForSelector('.review-list');
  assert.equal(await page.locator('.review-row').count(), 31);
  assert.ok(await page.locator('[data-testid="review-save"]').isDisabled());
  await page.click('.review-row[data-day="22"] .review-main');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="N1"]');
  await page.click('.sheet-day .btn-primary');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  await page.click('.review-row[data-day="26"] .review-main');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="F1"]');
  await page.click('.sheet .tile[data-code="TS"]');
  await page.click('.sheet-day .btn-primary');
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
  return { ctx, errors };
});

test('escanear: el reconocedor actual procesa una foto sin errores (revisión o plan B)', async () => {
  const s = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  const { page, ctx, errors } = await openApp({ state: s });
  await tab(page, 'escanear');
  await page.setInputFiles('input[data-testid="scan-pick"]', PHOTO);
  await page.waitForSelector('.fallback, .review-list', { timeout: 90000 });
  return { ctx, errors };
}, { slow: true });

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
  assert.match(await text(page, row(16)), /¿Seguro\?/);
  assert.match(await text(page, row(27)), /Nuevo/);
  assert.match(await text(page, '#view-escanear'), /Código nuevo: F4/);
  assert.match(await text(page, '#view-escanear'), /escanéala aparte/);
  assert.match(await text(page, '.review-counts'), /4.*días leídos/s);
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

test('códigos: confirmar el horario de F6 cambia las horas; crear un código nuevo desde un día', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState() });
  await tab(page, 'ajustes');
  await page.click('.code-row[data-code="F6"]');
  await sheetOpen(page);
  assert.match(await text(page, '.sheet'), /horario es supuesto/);
  await page.fill('.sheet-code input[type="time"] >> nth=0', '06:30');
  await page.fill('.sheet-code input[type="time"] >> nth=1', '14:30');
  await page.click('.sheet-code .btn-primary');
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
  await page.click('.sheet-code .btn-primary');
  await page.waitForSelector('.sheet-code', { state: 'detached' });
  assert.ok(await page.locator('.sheet-day .chip-code .badge[aria-label^="X1"]').count(), 'el código nuevo queda elegido');
  await page.click('.sheet-day .btn-primary');
  await page.waitForSelector('.sheet-wrap', { state: 'detached' });
  assert.match(await text(page, '.day-row[data-key="2026-10-20"]'), /08:00–12:00[\s\S]*4 h/);
  s = await getState(page);
  assert.equal(s.codes.X1.name, 'Formación');
  assert.equal(s.codes.X1.kind, 'shift');
  // Un código repetido da error
  await tab(page, 'ajustes');
  await page.click('#set-codes > .btn');
  await page.waitForSelector('.sheet-code');
  await page.waitForTimeout(400);
  await page.fill('.sheet-code .input-code', 'F1');
  await page.fill('.sheet-code input[type="time"] >> nth=0', '08:00');
  await page.fill('.sheet-code input[type="time"] >> nth=1', '12:00');
  await page.click('.sheet-code .btn-primary');
  assert.match(await text(page, '.form-error'), /ya existe/);
  return { ctx, errors };
});

test('copia de seguridad: exportar e importar', async () => {
  const state = demoState({ sync: true });
  const { page, ctx, errors } = await openApp({ state });
  await tab(page, 'ajustes');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('[data-fkey="btn-export"]'),
  ]);
  const file = path.join(ROOT, 'test/e2e/out/backup-test.json');
  await download.saveAs(file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(json.app, 'turnos-mauricio');
  assert.equal(Object.keys(json.days).length, Object.keys(state.days).length);
  assert.equal(json.settings.sync.token, '', 'la copia no lleva el token');
  // Borrar todo y restaurar
  await page.evaluate((k) => {
    localStorage.setItem(k, JSON.stringify({ schema: 1, settings: { onboardingDone: true }, days: {} }));
  }, STORAGE_KEY);
  await page.reload();
  await page.waitForSelector('.tabbar');
  await tab(page, 'ajustes');
  await page.setInputFiles('input[data-testid="import-file"]', file);
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog'), new RegExp(`${Object.keys(state.days).length} días`));
  await page.click('.dialog .btn-primary');
  await page.waitForTimeout(300);
  assert.equal(Object.keys((await getState(page)).days).length, Object.keys(state.days).length);
  // Un archivo que no es una copia da un error amable
  const bad = path.join(ROOT, 'test/e2e/out/no-es-copia.json');
  fs.writeFileSync(bad, '{"hola": 1}');
  await page.setInputFiles('input[data-testid="import-file"]', bad);
  await page.waitForSelector('.toast-error');
  return { ctx, errors };
});

test('enlace #setup: configura la sincronización tras confirmar, limpia la URL y publica', async () => {
  const link = core.buildSetupLink(APP, { owner: 'Mardar91', repo: 'mauricio', branch: 'datos', token: 'github_pat_TEST' });
  const { page, ctx, errors, net } = await openApp({ state: demoState(), hash: link.slice(APP.length) });
  await page.waitForSelector('.dialog-wrap.open');
  assert.match(await text(page, '.dialog'), /Mardar91\/mauricio/);
  assert.equal(await page.evaluate(() => location.hash), '', 'la URL queda limpia');
  await page.click('.dialog .btn-primary');
  // En Safari de iOS avisa de que la app instalada necesita el enlace pegado
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("Un detalle importante")');
  await page.click('.dialog .btn-primary');
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).settings.sync.lastPushAt, STORAGE_KEY, { timeout: 10000 });
  const s = await getState(page);
  assert.equal(s.settings.sync.enabled, true);
  assert.equal(s.settings.sync.token, 'github_pat_TEST');
  assert.ok(net.github.some((l) => /^PUT .*turnos\.ics$/.test(l)), 'publica turnos.ics');
  assert.ok(net.github.some((l) => /^PUT .*turnos\.json$/.test(l)), 'publica turnos.json');
  assert.match(net.files['turnos.ics'], /BEGIN:VCALENDAR/);
  assert.ok(!net.files['turnos.json'].includes('github_pat_TEST'), 'el token no se publica');
  await tab(page, 'ajustes');
  assert.match(await text(page, '[data-testid="sync-status"]'), /Funcionando/);
  assert.equal(await page.getAttribute('[data-testid="webcal"]', 'href'), 'webcal://raw.githubusercontent.com/Mardar91/mauricio/datos/turnos.ics');
  // Un cambio en un día se vuelve a publicar solo
  const puts = net.github.filter((l) => l.startsWith('PUT')).length;
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-20"]');
  await sheetOpen(page);
  await page.click('.sheet .tile[data-code="F1"]');
  await page.click('.sheet-day .btn-primary');
  await page.waitForTimeout(5500);
  assert.ok(net.github.filter((l) => l.startsWith('PUT')).length > puts, 'publica de nuevo tras un cambio');
  return { ctx, errors };
});

test('enlace de configuración pegado en Ajustes (app instalada)', async () => {
  const { page, ctx, errors, net } = await openApp({ state: demoState() });
  await tab(page, 'ajustes');
  await page.click('[data-testid="setup-paste-open"]');
  await sheetOpen(page);
  await page.fill('[data-testid="setup-paste"]', 'esto no es un enlace');
  await page.click('.sheet-footer .btn-primary');
  assert.match(await text(page, '.sheet .form-error'), /no sirve/);
  const link = core.buildSetupLink(APP, { owner: 'Mardar91', repo: 'mauricio', branch: 'datos', token: 'github_pat_PASTE' });
  await page.fill('[data-testid="setup-paste"]', `  ${link}\n`);
  await page.click('.sheet-footer .btn-primary');
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog .btn-primary');
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("Un detalle importante")');
  await page.click('.dialog .btn-primary');
  await page.waitForFunction((k) => JSON.parse(localStorage.getItem(k)).settings.sync.lastPushAt, STORAGE_KEY, { timeout: 10000 });
  assert.equal((await getState(page)).settings.sync.token, 'github_pat_PASTE');
  assert.ok(net.github.some((l) => /^PUT .*turnos\.ics$/.test(l)));
  return { ctx, errors };
});

test('primer uso con enlace #setup: primero el enlace y después la bienvenida', async () => {
  const link = core.buildSetupLink(APP, { owner: 'Mardar91', repo: 'mauricio', branch: 'datos', token: 'github_pat_X' });
  const { page, ctx, errors } = await openApp({ hash: link.slice(APP.length) });
  await page.waitForSelector('.dialog-wrap.open');
  assert.equal(await page.locator('.onboarding').count(), 0);
  await page.click('.dialog .btn-secondary');
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

test('ntfy: activar genera un tema, programa avisos y envía la prueba', async () => {
  const { page, ctx, errors, net } = await openApp({ state: demoState() });
  await tab(page, 'ajustes');
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

test('PWA: service worker, precache completo, versión y funcionamiento sin conexión', async () => {
  const { page, ctx, errors } = await openApp({ state: demoState(), sw: 'allow' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const sw = fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8');
  const version = /const VERSION = '([^']+)'/.exec(sw)[1];
  const appVersion = /export const APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'docs/js/app.js'), 'utf8'))[1];
  assert.equal(version, appVersion, 'VERSION de sw.js y APP_VERSION de app.js deben coincidir');
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

test('PWA: nueva versión → aviso «Actualizar» → recarga con la caché nueva', async () => {
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
    const page = await preparePage(ctx, { state: demoState(), errors });
    await mockNetwork(page);
    await page.goto(`http://127.0.0.1:${proxy.address().port}/docs/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    assert.equal(await page.locator('.toast').count(), 0, 'sin aviso en la primera instalación');
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
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-26"]');
  await sheetOpen(page);
  problems.push(...(await findOverflow(page)).map((p) => `editar día: ${p}`));
  await page.click('.sheet .tile[data-code="S1"]');
  await page.click('.sheet-day .btn-primary');
  await page.waitForSelector('.toast.show .toast-action');
  await page.waitForTimeout(350);
  problems.push(...(await findOverflow(page)).map((p) => `aviso: ${p}`));
  assert.deepEqual(problems, []);
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
