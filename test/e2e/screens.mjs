// Capturas de todas las vistas y estados (iPhone 390×844 @3x, claro y oscuro) en test/e2e/out/ para
// revisar el diseño, y comprobación de que nada se sale por los lados a 360 px (con capturas w360-*).
// Uso: node test/e2e/screens.mjs [--only nombre] [--theme light|dark] [--scale 3]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/serve.mjs';
import {
  KEY, NOW, OUT, OWNER, REPO, SYNC, TOKEN, core, demoState, ensureOut, fakeGitHub, findOverflow, iphoneContext, mockNetwork,
  preparePage, seedRemote,
} from './helpers.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', '');
const themes = opt('theme', '') ? [opt('theme')] : ['light', 'dark'];
const scale = Number(opt('scale', 3));

ensureOut();
if (!only) for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f));
const server = await startServer(0);
const APP = `${server.url}/docs/`;
const PHOTO = path.join(process.cwd(), 'test/fotos/phone-2026-10-b.jpg');
const PHOTO2 = path.join(process.cwd(), 'test/fotos/phone-2026-10-a.jpg');
const browser = await chromium.launch({ args: ['--lang=es-ES'] });
const problems = [];

// Reconocedor lento de mentira para capturar el progreso (y que después no lee nada)
const SLOW_RECOGNIZER = `export async function recognize(input, o = {}) {
  for (let i = 1; i <= 20; i++) { await new Promise((r) => setTimeout(r, 120)); o.onProgress?.(i / 20, i < 8 ? 'Buscando los días…' : 'Leyendo los turnos…'); }
  return { layout: 'unknown', month: null, year: null, days: [], warnings: [] };
}
export async function dispose() {}`;
const OCR_FAIL = `export async function recognize() { return { layout: 'unknown', month: null, year: null, days: [], ocrFailed: true,
  warnings: ['No se pudo iniciar el lector de texto. Comprueba la conexión a internet y vuelve a intentarlo.'] }; }
export async function dispose() {}`;

const FAKE_RESULT = {
  layout: 'phone-list', month: 10, year: 2026,
  days: [
    { day: 22, codes: ['N1'], confidence: 0.96 },
    { day: 23, codes: ['N1'], confidence: 0.95 },
    { day: 24, codes: ['-'], confidence: 0.9 },
    { day: 25, codes: ['-'], confidence: 0.92 },
    { day: 26, codes: ['F1', 'TS'], confidence: 0.88 },
    { day: 27, codes: ['F4'], confidence: 0.81 },
    { day: 28, codes: ['S1'], confidence: 0.55 },
    { day: 29, codes: ['S1', 'S54'], confidence: 0.9 },
    { day: 30, codes: ['W-'], confidence: 0.62, conflict: true, alternatives: [['U']] },
    { day: 31, codes: ['W-'], confidence: 0.93 },
  ],
  warnings: [],
};
// Noviembre: mes sin leer, un día dudoso y días que no se pudieron leer
const HARD_RESULT = {
  layout: 'phone-list', month: null, year: null,
  days: [
    { day: 2, codes: ['F1', 'F51'], confidence: 0.95 },
    { day: 3, codes: ['S1', 'S52'], confidence: 0.52 },
    { day: 4, codes: ['N1', 'N51'], confidence: 0.94 },
    { day: 7, codes: ['-'], confidence: 0.9 },
  ],
  unread: [6],
  warnings: ['No pude leer el mes con seguridad: elígelo a mano.', 'No pude leer bien el día 5: revísalo a mano.'],
};

// Estado de demostración con un «horario especial» hoy (S1 de 15:00 a 20:00) y el 29 (S1 14:00–20:00)
function specialState(extra = {}) {
  let s = demoState(extra);
  s = core.setDay(s, '2026-10-13', ['S1', 'S51'], { source: 'manual', times: { S1: { start: '15:00', end: '20:00', breakMin: 0 } }, now: new Date('2026-10-12T20:00:00+02:00') });
  s = core.setDay(s, '2026-10-29', ['S1', 'S54'], { source: 'manual', times: { S1: { start: '14:00', end: '20:00', breakMin: 0 } }, now: new Date('2026-10-12T20:00:00+02:00') });
  return s;
}
const SUBSCRIBED = `webcal://raw.githubusercontent.com/${OWNER}/${REPO}/HEAD/turnos.ics`;
async function markSubscribed(page) {
  await page.addInitScript((url) => localStorage.setItem('turnos-mauricio:subscribed', JSON.stringify({ url, at: '2026-10-02T18:00:00.000Z' })), SUBSCRIBED);
}

const scenarios = [];
const scenario = (name, fn, opts = {}) => scenarios.push({ name, fn, opts });

async function snap(page, name, { full = false, theme } = {}) {
  await page.waitForTimeout(450);
  const file = path.join(OUT, `${name}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: full });
  return file;
}

// standalone: app instalada (por defecto); false = pestaña de Safari
async function open(context, { state, now = NOW, standalone = true, gh, hash = '' } = {}) {
  const errors = [];
  const page = await preparePage(context, { state, now, errors, standalone });
  await mockNetwork(page, { gh });
  await page.goto(APP + hash);
  await page.waitForSelector('.tabbar', { state: 'attached' });
  await page.waitForTimeout(300);
  page.__errors = errors;
  return page;
}

const tab = (page, id) => page.click(`.tab[data-tab="${id}"]`);
const sheet = (page) => page.waitForSelector('.sheet-wrap.open').then(() => page.waitForTimeout(400));
const closeSheet = async (page) => { await page.keyboard.press('Escape'); await page.waitForTimeout(350); };
const connected = (extra = {}) => demoState({ sync: true, ...extra });
const setupHash = () => core.buildSetupLink(APP, { owner: OWNER, repo: REPO, branch: '', token: TOKEN, key: KEY }).slice(APP.length);

scenario('onboarding', async (ctx, theme) => {
  const page = await open(ctx, { state: null, standalone: false });
  await page.waitForSelector('.onboarding.open');
  await snap(page, '01-onboarding-1', { theme });
  await page.click('.ob-bottom .btn-primary');
  await snap(page, '01-onboarding-2-instalar', { theme });
  await page.click('.ob-bottom .btn-primary');
  await snap(page, '01-onboarding-3-avisos', { theme });
  await page.click('.ob-bottom .btn-primary');
  await page.waitForTimeout(400);
  await snap(page, '02-safari-hoy-vacio', { theme });
  await page.click('[data-testid="banner-safari"] .banner-btn');
  await sheet(page);
  await snap(page, '02-safari-instalar', { theme });
  return page;
});

scenario('hoy-vacio', async (ctx, theme) => {
  const s = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  const page = await open(ctx, { state: s });
  await snap(page, '03-hoy-vacio', { theme });
  return page;
});

scenario('hoy', async (ctx, theme) => {
  const page = await open(ctx, { state: connected() });
  await page.waitForFunction(() => /al día/.test(document.querySelector('[data-testid="sync-line"]')?.textContent || ''), null, { timeout: 10000 });
  await snap(page, '04-hoy', { theme });
  await snap(page, '04-hoy-completo', { theme, full: true });
  return page;
});

scenario('hoy-safari', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState(), standalone: false });
  await snap(page, '04-hoy-safari', { theme });
  return page;
});

scenario('hoy-trabajando', async (ctx, theme) => {
  const page = await open(ctx, { state: connected(), standalone: false, now: new Date('2026-10-13T17:40:00+02:00') });
  await snap(page, '05-hoy-trabajando', { theme });
  return page;
});

scenario('hoy-noche', async (ctx, theme) => {
  const page = await open(ctx, { state: connected(), standalone: false, now: new Date('2026-10-16T19:05:00+02:00') });
  await snap(page, '05-hoy-libre-noche', { theme });
  return page;
});

scenario('hoy-error', async (ctx, theme) => {
  const page = await open(ctx, { state: connected(), gh: fakeGitHub({ status: 401 }) });
  await page.waitForSelector('[data-testid="sync-line"].sync-alert', { timeout: 10000 });
  await snap(page, '05-hoy-calendario-con-error', { theme });
  return page;
});

scenario('calendario', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'calendario');
  await snap(page, '06-calendario', { theme });
  await page.evaluate(() => window.scrollTo(0, 0));
  await snap(page, '06-calendario-arriba', { theme });
  await snap(page, '06-calendario-completo', { theme, full: true });
  for (let i = 0; i < 4; i++) await page.click('#view-calendario button[aria-label="Mes anterior"]');
  await snap(page, '07-calendario-junio', { theme, full: true });
  await page.click('.today-btn');
  for (let i = 0; i < 2; i++) await page.click('#view-calendario button[aria-label="Mes siguiente"]');
  await snap(page, '07-calendario-mes-vacio', { theme });
  return page;
});

scenario('editar-dia', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-15"]');
  await sheet(page);
  await snap(page, '08-editar-dia', { theme });
  await page.evaluate(() => { const b = document.querySelector('.sheet-body'); b.scrollTop = b.scrollHeight; });
  await page.click('.de-history summary');
  await page.evaluate(() => { const b = document.querySelector('.sheet-body'); b.scrollTop = b.scrollHeight; });
  await snap(page, '08-editar-dia-abajo', { theme });
  await page.click('.new-code-btn');
  await page.waitForTimeout(500);
  await page.fill('.sheet-code .input-code', 'F4');
  await page.fill('.sheet-code input[placeholder^="Ej.: Mañana"]', 'Mañana corta');
  await page.fill('.sheet-code input[type="time"] >> nth=0', '07:00');
  await page.fill('.sheet-code input[type="time"] >> nth=1', '13:00');
  await snap(page, '09-codigo-nuevo', { theme });
  await page.click('.sheet-code .sheet-close');
  await page.waitForSelector('.dialog-wrap.open');
  await snap(page, '10-salir-sin-guardar', { theme });
  await page.click('.dialog-wrap.open .btn-danger');
  await page.waitForTimeout(400);
  await page.click('.sheet-day .btn-danger-plain');
  await snap(page, '10-confirmar-borrar', { theme });
  await page.click('.dialog-wrap.open .btn-secondary');
  await page.click('.tile[data-code="F1"]');
  await page.click('[data-testid="day-save"]');
  await page.waitForSelector('.toast.show');
  await snap(page, '11-guardado-toast', { theme });
  return page;
});

scenario('especial', async (ctx, theme) => {
  const page = await open(ctx, { state: specialState({ sync: true }) });
  await snap(page, '25-hoy-horario-especial', { theme });
  await tab(page, 'calendario');
  await snap(page, '25-calendario-horario-especial', { theme });
  await page.click('.day-row[data-key="2026-10-13"]');
  await sheet(page);
  await snap(page, '25-editar-dia-especial', { theme });
  await closeSheet(page);
  await page.click('.day-row[data-key="2026-10-14"]');
  await sheet(page);
  await page.click('.tile[data-code="S1"]');
  await snap(page, '25-editar-dia-normal', { theme });
  await page.click('[data-testid="day-time-edit"]');
  await page.fill('[data-testid="day-time-start"]', '16:00');
  await page.fill('[data-testid="day-time-end"]', '21:30');
  await page.waitForTimeout(200);
  await snap(page, '25-editar-dia-solo-este-dia', { theme });
  await page.click('[data-testid="code-all-days"]');
  await sheet(page);
  await snap(page, '25-codigo-todos-los-dias', { theme });
  await page.fill('.sheet-code input[type="time"] >> nth=0', '14:00');
  await page.click('[data-testid="code-save"]');
  await page.waitForSelector('.dialog-wrap.open');
  await snap(page, '25-codigo-confirmar-todos', { theme });
  return page;
});

scenario('codigos', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'ajustes');
  await page.click('.code-row[data-code="S1"]');
  await sheet(page);
  await snap(page, '09-codigo-s1', { theme });
  await page.click('.sheet-code .ce-more > summary');
  await page.evaluate(() => { const b = document.querySelector('.sheet-body'); b.scrollTop = b.scrollHeight; });
  await snap(page, '09-codigo-s1-mas-opciones', { theme });
  await closeSheet(page);
  await page.click('[data-testid="places"] > summary');
  await page.click('.code-row[data-code="S51"]');
  await sheet(page);
  await snap(page, '09-codigo-lugar', { theme });
  await closeSheet(page);
  await page.click('[data-testid="codes-all"]');
  await page.click('.code-row[data-code="F6"]');
  await sheet(page);
  await snap(page, '19-codigo-sin-confirmar', { theme });
  return page;
});

scenario('escanear', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'escanear');
  await snap(page, '12-escanear', { theme });
  await page.route('**/docs/js/recognize/index.js', (r) => r.fulfill({ contentType: 'text/javascript', body: SLOW_RECOGNIZER }));
  await page.setInputFiles('input[data-testid="scan-pick"]', [PHOTO, PHOTO2]);
  await page.waitForSelector('.photo-item');
  await page.waitForTimeout(1600);
  await snap(page, '13-escanear-leyendo', { theme });
  await page.waitForSelector('.fallback', { timeout: 15000 });
  await snap(page, '14-escanear-no-leido', { theme });
  await page.selectOption('.fallback .month-picker select >> nth=0', '10');
  await page.click('[data-testid="fallback-manual"]');
  await page.waitForSelector('.review-list');
  await snap(page, '15-a-mano', { theme });
  await page.click('.review-row[data-day="22"] .review-main');
  await sheet(page);
  await page.click('.tile[data-code="S1"]');
  await snap(page, '15-a-mano-editor', { theme });
  await page.click('.de-photo-btn');
  await sheet(page);
  await page.waitForTimeout(300);
  await snap(page, '15-a-mano-foto', { theme });
  await closeSheet(page);
  await page.click('[data-testid="day-done"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 1500));
  await snap(page, '15-a-mano-abajo', { theme });
  return page;
});

scenario('escanear-safari', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState(), standalone: false });
  await tab(page, 'escanear');
  await snap(page, '12-escanear-safari', { theme });
  return page;
});

scenario('ocr-fallo', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await page.route('**/docs/js/recognize/index.js', (r) => r.fulfill({ contentType: 'text/javascript', body: OCR_FAIL }));
  await tab(page, 'escanear');
  await page.setInputFiles('input[data-testid="scan-pick"]', PHOTO);
  await page.waitForSelector('[data-testid="ocr-failed"]');
  await snap(page, '14-escanear-lector-no-arranca', { theme });
  return page;
});

scenario('revision', async (ctx, theme) => {
  const page = await open(ctx, { state: specialState() });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), FAKE_RESULT);
  await page.waitForSelector('.review-list');
  await snap(page, '16-revision', { theme });
  await snap(page, '16-revision-completa', { theme, full: true });
  await page.evaluate(() => window.scrollTo(0, 99999));
  await snap(page, '16-revision-abajo', { theme });
  return page;
});

scenario('revision-dificil', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), HARD_RESULT);
  await page.waitForSelector('.review-list');
  await snap(page, '16-revision-sin-mes', { theme });
  await page.selectOption('.review-month select >> nth=0', '11');
  await snap(page, '16-revision-sin-leer', { theme, full: true });
  await page.evaluate(() => window.scrollTo(0, 99999));
  await page.click('[data-testid="review-save"]');
  await page.waitForSelector('.dialog-wrap.open');
  await snap(page, '16-revision-faltan-dias', { theme });
  return page;
});

scenario('revision-al-dia', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), {
    layout: 'phone-list', month: 10, year: 2026, warnings: [],
    days: [{ day: 13, codes: ['S1', 'S51'], confidence: 0.97 }, { day: 14, codes: ['-'], confidence: 0.95 }, { day: 15, codes: ['S1', 'S31'], confidence: 0.95 }],
  });
  await page.waitForSelector('.review-list');
  await snap(page, '16-revision-al-dia', { theme });
  return page;
});

scenario('horas', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'horas');
  await snap(page, '17-horas', { theme });
  await snap(page, '17-horas-completo', { theme, full: true });
  await page.evaluate(() => window.__turnosTest.store.set((s) => { s.days['2026-11-02'] = { codes: ['F1', 'F51'], note: '', source: 'manual', updatedAt: '2026-10-12T10:00:00.000Z' }; return s; }));
  await page.click('#view-horas button[aria-label="Mes siguiente"]');
  await snap(page, '17-horas-mes-a-medias', { theme });
  return page;
});

scenario('ajustes', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'ajustes');
  await snap(page, '18-ajustes-sin-conectar', { theme });
  await snap(page, '18-ajustes-sin-conectar-completo', { theme, full: true });
  await page.click('#set-advanced > summary');
  await page.waitForTimeout(200);
  await snap(page, '18-ajustes-avanzado-completo', { theme, full: true });
  await page.click('[data-testid="setup-paste-open"]');
  await sheet(page);
  await snap(page, '20-tengo-un-enlace', { theme });
  return page;
});

scenario('ajustes-conectado', async (ctx, theme) => {
  const page = await open(ctx, { state: connected({ ntfy: true }), standalone: false });
  await tab(page, 'ajustes');
  await snap(page, '18-ajustes-conectado', { theme });
  await page.click('details[data-fkey="guide-cal"] summary');
  await snap(page, '18-ajustes-conectado-completo', { theme, full: true });
  return page;
});

scenario('ajustes-suscrito', async (ctx, theme) => {
  const errors = [];
  const page = await preparePage(ctx, { state: connected(), now: NOW, errors, standalone: true });
  await markSubscribed(page);
  await mockNetwork(page);
  page.__errors = errors;
  await page.goto(APP);
  await page.waitForSelector('.tabbar', { state: 'attached' });
  await tab(page, 'ajustes');
  await page.waitForTimeout(300);
  await snap(page, '18-ajustes-suscrito', { theme });
  await page.click('[data-testid="subscribe-again"]');
  await page.waitForSelector('.dialog-wrap.open');
  await snap(page, '18-ajustes-suscribirme-otra-vez', { theme });
  return page;
});

scenario('ajustes-safari', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState(), standalone: false });
  await tab(page, 'ajustes');
  await snap(page, '18-ajustes-safari', { theme });
  await page.click('[data-testid="cal-install"]');
  await sheet(page);
  await snap(page, '02-guia-instalar-ios26', { theme });
  return page;
});

scenario('ajustes-version', async (ctx, theme) => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'iphone1' });
  const doc = gh.json('backup.json');
  doc.v = 9;
  gh.write('backup.json', JSON.stringify(doc));
  const page = await open(ctx, { state: core.updateSettings(demoState(), { sync: { ...SYNC, deviceId: 'iphone1' } }), gh });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('turnos-mauricio:v1')).settings.sync.lastErrorCode === 'NEWER_REMOTE', null, { timeout: 10000 });
  await snap(page, '05-hoy-actualizar-app', { theme });
  await tab(page, 'ajustes');
  await snap(page, '18-ajustes-error-version', { theme });
  return page;
});

scenario('ajustes-solo-lectura', async (ctx, theme) => {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'navegador' });
  const st = core.updateSettings(demoState(), { sync: { ...SYNC, deviceId: 'iphone1' } });
  const page = await open(ctx, { state: st, gh });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('turnos-mauricio:v1')).settings.sync.publisher === 'navegador', null, { timeout: 10000 });
  await tab(page, 'ajustes');
  await page.waitForSelector('[data-testid="takeover"]');
  await snap(page, '18-ajustes-solo-lectura', { theme });
  await page.click('[data-testid="takeover"]');
  await page.waitForSelector('.dialog-wrap.open');
  await snap(page, '18-ajustes-usar-este', { theme });
  return page;
});

scenario('ajustes-error', async (ctx, theme) => {
  const page = await open(ctx, { state: connected(), gh: fakeGitHub({ status: 401 }) });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('turnos-mauricio:v1')).settings.sync.lastErrorCode === 'AUTH', null, { timeout: 10000 });
  await tab(page, 'ajustes');
  await snap(page, '18-ajustes-error', { theme });
  return page;
});

scenario('setup', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState(), hash: setupHash() });
  await page.waitForSelector('.dialog-wrap.open');
  await snap(page, '21-enlace-confirmar', { theme });
  await page.click('.dialog-wrap.open .btn-primary');
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await page.waitForSelector('.sheet-subscribe [data-testid="webcal"][aria-disabled="false"]');
  await snap(page, '22-suscribirme', { theme });
  await page.evaluate(() => document.addEventListener('click', (e) => { if (e.target.closest?.('a[href^="webcal:"]')) e.preventDefault(); }));
  await page.click('.sheet-subscribe [data-testid="webcal"]');
  await page.waitForSelector('[data-testid="subscribe-done"]');
  await snap(page, '22-suscribirme-hecho', { theme });
  return page;
});

scenario('setup-sin-internet', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState(), hash: setupHash() });
  await page.route('https://api.github.com/**', (r) => r.abort('internetdisconnected'));
  await page.waitForSelector('.dialog-wrap.open');
  await page.click('.dialog-wrap.open .btn-primary');
  await page.waitForSelector('[data-testid="offline-hint"]', { timeout: 15000 });
  await snap(page, '22-suscribirme-sin-internet', { theme });
  return page;
});

scenario('setup-safari-nuevo', async (ctx, theme) => {
  const page = await open(ctx, { state: null, hash: setupHash(), standalone: false });
  await page.waitForSelector('[data-testid="setup-safari"]');
  await page.waitForTimeout(500);
  await snap(page, '21-enlace-en-safari-primera-vez', { theme });
  return page;
});

scenario('setup-safari', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState(), hash: setupHash(), standalone: false });
  await page.waitForSelector('[data-testid="setup-safari"]');
  await page.waitForTimeout(300);
  await snap(page, '21-enlace-en-safari', { theme });
  return page;
});

scenario('importar', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'ajustes');
  let small = core.createDefaultState();
  for (const [k, c] of [['2026-10-20', ['F1']], ['2026-10-21', ['S1']], ['2026-10-22', ['N1']]]) small = core.setDay(small, k, c, { now: new Date('2026-10-01T10:00:00Z') });
  const file = path.join(OUT, 'copia-pequena.json');
  fs.writeFileSync(file, core.exportBackup(small, { now: new Date('2026-10-01T10:00:00Z') }));
  await page.setInputFiles('input[data-testid="import-file"]', file);
  await page.waitForSelector('.dialog-wrap.open');
  await snap(page, '23-importar-confirmar', { theme });
  await page.click('.dialog-wrap.open .btn-danger');
  await page.waitForSelector('.toast.show .toast-action');
  await snap(page, '23-importar-deshacer', { theme });
  return page;
});

scenario('avisos-fijos', async (ctx, theme) => {
  const st = demoState();
  st.schema = 99;
  const page = await open(ctx, { state: st });
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('turnos-mauricio')) throw new DOMException('lleno', 'QuotaExceededError'); return orig.call(this, k, v); };
    window.__turnosTest.store.set((s) => { s.days['2026-10-14'] = { codes: ['F1'], note: '', source: 'manual', updatedAt: new Date().toISOString() }; return s; });
  });
  await page.waitForSelector('[data-testid="banner-save"]');
  await snap(page, '24-avisos-guardar-y-version', { theme });
  page.__errors = page.__errors.filter((e) => !/no se pudo guardar/i.test(e));
  return page;
});

for (const theme of themes) {
  for (const sc of scenarios) {
    if (only && !sc.name.includes(only)) continue;
    const ctx = await iphoneContext(browser, { theme, scale });
    try {
      const page = await sc.fn(ctx, theme);
      for (const e of page.__errors || []) problems.push(`[${sc.name}/${theme}] ${e}`);
    } catch (e) {
      problems.push(`[${sc.name}/${theme}] FALLO: ${e.message.split('\n')[0]}`);
    }
    await ctx.close();
  }
}

// Desbordamientos a 360 px (y 390) en las vistas principales
if (!only || only === 'overflow') {
  for (const width of [360, 390]) {
    const ctx = await iphoneContext(browser, { width, height: 740, scale: width === 360 ? 2 : 1 });
    const page = await open(ctx, { state: demoState({ sync: true, ntfy: true }), standalone: false });
    for (const t of ['hoy', 'calendario', 'escanear', 'horas', 'ajustes']) {
      await tab(page, t);
      await page.waitForTimeout(200);
      if (t === 'ajustes') { await page.click('#set-advanced > summary'); await page.waitForTimeout(150); }
      const of = await findOverflow(page);
      for (const o of of) problems.push(`[${width}px ${t}] ${o}`);
      if (width === 360) await page.screenshot({ path: path.join(OUT, `w360-${t}.png`), fullPage: true });
    }
    await tab(page, 'calendario');
    await page.click('.day-row[data-key="2026-10-26"]');
    await page.waitForSelector('.sheet-wrap.open');
    await page.waitForTimeout(400);
    for (const o of await findOverflow(page)) problems.push(`[${width}px editar-dia] ${o}`);
    if (width === 360) await page.screenshot({ path: path.join(OUT, 'w360-editar-dia.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.sheet-wrap', { state: 'detached' });
    await page.evaluate((r) => window.__turnosTest.injectScanResult(r), HARD_RESULT);
    await page.waitForSelector('.review-list');
    await page.selectOption('.review-month select >> nth=0', '11');
    await page.waitForTimeout(500);
    for (const o of await findOverflow(page)) problems.push(`[${width}px revision] ${o}`);
    if (width === 360) await page.screenshot({ path: path.join(OUT, 'w360-revision.png'), fullPage: true });
    for (const e of page.__errors) problems.push(`[${width}px] ${e}`);
    await ctx.close();
  }
}

await browser.close();
await server.close();
if (problems.length) {
  console.log('PROBLEMAS:\n' + problems.map((p) => '  ' + p).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`OK: capturas en ${OUT}`);
}
