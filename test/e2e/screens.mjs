// Capturas de todas las vistas y estados (iPhone 390×844 @3x, claro y oscuro) en test/e2e/out/ para
// revisar el diseño, y las pantallas clave en varios tamaños (SPEC §14): Android 360×740, iPhone 390×844
// y 430×932 (claro y oscuro), iPad 820×1180 y 1180×820 y ordenador 1280×800 (r-<tamaño>-*), comprobando
// que nada se sale por los lados.
// Uso: node test/e2e/screens.mjs [--only nombre] [--theme light|dark] [--scale 3]   (--only responsive: solo tamaños)
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/serve.mjs';
import {
  KEY, NOW, OTHER_KEY, OUT, OWNER, REPO, SYNC, TOKEN, core, demoState, ensureOut, fakeGitHub, findOverflow, iphoneContext,
  mockNetwork, preparePage, seedRemote,
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
// Con lo nuevo de §11–§13: nombre, viaje al lugar S51 (25 min, con dirección), salario por hora,
// saldo inicial y vacaciones del año pasado, y un día de enfermedad (K)
function richState(extra = {}) {
  let s = demoState(extra);
  s = core.upsertCode(s, { ...core.getCode(s, 'S51'), place: 'Karl-Marx-Straße 101, Berlín', travelMin: 25 });
  s = core.updateSettings(s, {
    name: 'Mauricio', planName: 'Ducuara Mauricio',
    supplements: { hourlyWage: 18.5 }, balances: { overtimeStartMin: 300, overtimeStartMonth: '2026-06', vacationCarryOver: 2 },
  });
  s = core.setDay(s, '2026-10-08', ['K'], { source: 'manual', now: new Date('2026-10-08T07:00:00+02:00') });
  return s;
}
// GitHub con dos calendarios: el de Mauricio (raíz) y el de Ana (carpeta «ana»)
async function familyGitHub() {
  const gh = fakeGitHub();
  await seedRemote(gh, demoState(), { deviceId: 'iphone1', name: 'Mauricio' });
  let ana = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  for (const [k, c] of [['2026-10-13', ['F1']], ['2026-10-14', ['S1']], ['2026-10-15', ['-']]]) ana = core.setDay(ana, k, c, { now: new Date('2026-10-10T10:00:00Z') });
  await seedRemote(gh, ana, { deviceId: 'android-ana', dir: 'ana', key: OTHER_KEY, name: 'Ana' });
  return gh;
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
  await page.fill('[data-testid="ob-name"]', 'Mauricio');
  await snap(page, '01-onboarding-2-nombre', { theme });
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

scenario('nuevo', async (ctx, theme) => {
  // Hoy con tiempo de viaje, Horas con suplementos y saldos, Ajustes «Contrato y nómina», editor del lugar
  const page = await open(ctx, { state: richState({ sync: true }) });
  await snap(page, '26-hoy-viaje', { theme });
  await tab(page, 'horas');
  await page.evaluate(() => document.getElementById('hours-supplements')?.scrollIntoView({ block: 'start' }));
  await snap(page, '26-horas-suplementos-saldos', { theme });
  await snap(page, '26-horas-completo', { theme, full: true });
  await tab(page, 'ajustes');
  await page.click('[data-testid="payroll"] > summary');
  await page.evaluate(() => document.getElementById('set-payroll')?.scrollIntoView({ block: 'start' }));
  await snap(page, '26-ajustes-nomina', { theme });
  await page.evaluate(() => document.getElementById('set-reminders')?.scrollIntoView({ block: 'start' }));
  await snap(page, '26-ajustes-avisos-nombre', { theme });
  await page.click('[data-testid="places"] > summary');
  await page.click('.code-row[data-code="S51"]');
  await sheet(page);
  await snap(page, '26-lugar-viaje-mapas', { theme });
  await closeSheet(page);
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-20"]');
  await sheet(page);
  await snap(page, '26-editar-dia-con-K', { theme });
  return page;
});

scenario('familia', async (ctx, theme) => {
  const gh = await familyGitHub();
  const st = core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'iphone1' } });
  const page = await open(ctx, { state: st, gh });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('turnos-mauricio:v1')).settings.sync.lastPullAt, null, { timeout: 10000 });
  await tab(page, 'ajustes');
  await page.waitForSelector('#set-family', { timeout: 10000 });
  await page.evaluate(() => document.getElementById('set-family').scrollIntoView({ block: 'start' }));
  await snap(page, '27-calendarios-familia', { theme });
  // iPhone: «Ver sus turnos» primero avisa «deja ACTIVADO Eliminar alertas»
  await page.click('#set-family [data-dir="ana"] [data-testid="family-subscribe"]');
  await page.waitForSelector('.dialog-wrap.open');
  await page.waitForTimeout(250);
  await snap(page, '27-familia-ios-solo-mirar', { theme });
  await page.click('.dialog-wrap.open .btn-secondary');
  await page.waitForSelector('.dialog-wrap', { state: 'detached' });
  await page.click('[data-testid="advanced"] > summary');
  await page.click('[data-testid="make-person-link"]');
  await sheet(page);
  await snap(page, '27-enlace-otra-persona', { theme });
  await page.fill('[data-testid="person-name"]', 'Lucía');
  await page.click('[data-testid="person-create"]');
  await page.waitForSelector('[data-testid="person-result"]:not([hidden])');
  await snap(page, '27-enlace-otra-persona-listo', { theme });
  return page;
});

scenario('android', async (_ctx, theme) => {
  // La hermana: Android (Chrome), conectada a la carpeta «ana»
  const ctx = await iphoneContext(browser, { theme, scale, device: 'android', width: 360, height: 740 });
  const gh = await familyGitHub();
  let st = core.updateSettings(demoState(), { name: 'Ana', planName: 'Ducuara Ana', sync: { ...SYNC, key: OTHER_KEY, dir: 'ana', deviceId: 'android-ana' } });
  st = core.upsertCode(st, { ...core.getCode(st, 'S51'), place: 'Karl-Marx-Straße 101, Berlín', travelMin: 25 });
  const page = await open(ctx, { state: st, gh, standalone: false });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('turnos-mauricio:v1')).settings.sync.lastPullAt, null, { timeout: 10000 });
  await snap(page, '28-android-hoy', { theme });
  await tab(page, 'ajustes');
  await snap(page, '28-android-ajustes', { theme });
  await page.click('details[data-fkey="guide-icsx5"] > summary');
  await snap(page, '28-android-ajustes-completo', { theme, full: true });
  await page.waitForSelector('#set-family');
  await page.click('#set-family [data-testid="family-subscribe"]');
  await sheet(page);
  await snap(page, '28-android-ver-sus-turnos', { theme });
  await ctx.close();
  // Primer uso en Android (Chrome, con el botón «Instalar la app» de Chrome)
  const ctx2 = await iphoneContext(browser, { theme, scale, device: 'android', width: 360, height: 740 });
  const p2 = await open(ctx2, { state: null, standalone: false });
  await p2.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = async () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); });
  await p2.waitForSelector('.onboarding.open');
  await p2.click('.ob-bottom .btn-primary');
  await p2.fill('[data-testid="ob-name"]', 'Ana');
  await snap(p2, '28-android-bienvenida-nombre', { theme });
  await p2.click('.ob-bottom .btn-primary');
  await snap(p2, '28-android-bienvenida-instalar', { theme });
  // Enlace abierto en Chrome → último paso con ICSx⁵
  const ctx3 = await iphoneContext(browser, { theme, scale, device: 'android', width: 360, height: 740 });
  const hash = core.buildPersonLink(APP, { owner: OWNER, repo: REPO, branch: '', token: TOKEN }, { name: 'Ana', existingDirs: [] }).link.slice(APP.length);
  const p3 = await open(ctx3, { state: core.updateSettings(core.createDefaultState(), { onboardingDone: true }), hash, standalone: false });
  await p3.waitForSelector('.dialog-wrap.open');
  await snap(p3, '28-android-enlace-confirmar', { theme });
  await p3.click('.dialog-wrap.open .btn-primary');
  await p3.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await p3.waitForSelector('.sheet-subscribe [data-testid="webcal"][aria-disabled="false"]', { timeout: 15000 });
  await snap(p3, '28-android-ultimo-paso', { theme });
  for (const p of [p2, p3]) for (const e of p.__errors) problems.push(`[android/${theme}] ${e}`);
  await ctx2.close();
  await ctx3.close();
  return page;
});

scenario('viaje-dia', async (ctx, theme) => {
  // Editor del día con viaje y mapa; «Restablecer» un lugar con dirección
  let st = demoState();
  st = core.upsertCode(st, { ...core.getCode(st, 'S51'), place: 'Karl-Marx-Straße 101, Berlín', travelMin: 25 });
  const page = await open(ctx, { state: st });
  await snap(page, '29-hoy-viaje', { theme });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-13"]');
  await sheet(page);
  await snap(page, '29-editar-dia-viaje-mapas', { theme });
  await closeSheet(page);
  await page.click('.day-row[data-key="2026-10-03"]');
  await sheet(page);
  await snap(page, '29-editar-dia-libre', { theme });
  await closeSheet(page);
  await tab(page, 'ajustes');
  await page.click('[data-testid="places"] > summary');
  await page.click('.code-row[data-code="S51"]');
  await sheet(page);
  await page.click('.sheet-code .btn-danger-plain');
  await page.waitForSelector('.dialog-wrap.open');
  await page.waitForTimeout(250);
  await snap(page, '29-restablecer-lugar', { theme });
  await page.click('.dialog-wrap.open .btn-secondary');
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

scenario('v142', async (_ctx, theme) => {
  // Teléfono (Android) con el calendario de Mauricio que abre el enlace de Ana: pregunta antes de cambiar
  const ctx = await iphoneContext(browser, { theme, scale, device: 'android', width: 360, height: 740 });
  const gh = await familyGitHub();
  const st = core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'android1' } });
  const page = await open(ctx, { state: st, gh, standalone: false });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('turnos-mauricio:v1')).settings.sync.lastPullAt, null, { timeout: 10000 });
  const anaHash = core.buildSetupLink(APP, { owner: OWNER, repo: REPO, branch: '', token: TOKEN, key: OTHER_KEY, dir: 'ana', name: 'Ana' }).slice(APP.length);
  await page.evaluate((hsh) => { location.hash = hsh; }, anaHash);
  // Ya usa otro calendario: directamente la pregunta (sin «Conectar…»)
  await page.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Cambiar al calendario de Ana?")', { timeout: 15000 });
  await snap(page, '30-cambiar-calendario', { theme });
  await page.click('.dialog-wrap.open .btn-primary');
  // Es de Ana y este teléfono es de Mauricio: solo lee (no se ofrece tomar el relevo)
  await page.waitForSelector('[data-testid="subscribe-step"]', { timeout: 15000 });
  await page.waitForSelector('.sheet-subscribe [data-testid="webcal"][aria-disabled="false"]', { timeout: 15000 });
  await snap(page, '30-cambiado-ultimo-paso', { theme });
  for (const e of page.__errors) problems.push(`[v142/${theme}] ${e}`);
  await ctx.close();
  // 1.4.3: teléfono sin nombre y con turnos que abre el enlace de Mauricio: «¿Estos turnos son de Mauricio?»
  const ctxB = await iphoneContext(browser, { theme, scale, device: 'android', width: 360, height: 740 });
  let anaSt = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  anaSt = core.setDay(anaSt, '2026-10-15', ['N1'], { now: new Date('2026-10-12T10:00:00Z') });
  const pB = await open(ctxB, { state: anaSt, gh: await familyGitHub(), standalone: false });
  const mauHash = core.buildSetupLink(APP, { owner: OWNER, repo: REPO, branch: '', token: TOKEN, key: KEY, name: 'Mauricio' }).slice(APP.length);
  await pB.evaluate((hsh) => { location.hash = hsh; }, mauHash);
  await pB.waitForSelector('.dialog-wrap.open .dialog-title:text("¿Estos turnos son de Mauricio?")', { timeout: 15000 });
  await snap(pB, '31-de-quien-son-los-turnos', { theme });
  for (const e of pB.__errors) problems.push(`[v143/${theme}] ${e}`);
  await ctxB.close();
  // Ordenador de quien ayuda: guardar sin internet
  const ctx2 = await iphoneContext(browser, { theme, scale: 1, device: 'desktop', width: 1280, height: 800 });
  const gh2 = fakeGitHub({ empty: true });
  const p2 = await open(ctx2, { state: core.updateSettings(core.createDefaultState(), { onboardingDone: true }), gh: gh2, standalone: false });
  await p2.route('https://api.github.com/**', (r) => r.abort('internetdisconnected'));
  await tab(p2, 'ajustes');
  await p2.click('[data-testid="advanced"] > summary');
  await p2.fill('[data-fkey="gh-owner"]', OWNER);
  await p2.fill('[data-fkey="gh-repo"]', REPO);
  await p2.fill('[data-fkey="gh-token"]', TOKEN);
  await p2.click('[data-fkey="btn-connect"]');
  await p2.waitForSelector('.dialog-wrap.open .dialog-title:text("Guardado, sin conexión")', { timeout: 15000 });
  await snap(p2, '30-quien-ayuda-sin-conexion', { theme });
  await ctx2.close();
  // «Crear enlace» no disponible (la clave ya no vale)
  const ctx3 = await iphoneContext(browser, { theme, scale });
  const gh3 = fakeGitHub();
  await seedRemote(gh3, demoState(), { deviceId: 'iphone1', key: OTHER_KEY });
  const p3 = await open(ctx3, { state: core.updateSettings(demoState(), { name: 'Mauricio', sync: { ...SYNC, deviceId: 'pc1', lastPullAt: '2026-10-12T08:00:00.000Z' } }), gh: gh3 });
  await p3.waitForFunction(() => JSON.parse(localStorage.getItem('turnos-mauricio:v1')).settings.sync.lastErrorCode === 'DECRYPT', null, { timeout: 10000 });
  await tab(p3, 'ajustes');
  await p3.click('[data-testid="advanced"] > summary');
  await p3.locator('[data-testid="make-link-blocked"]').scrollIntoViewIfNeeded();
  await p3.evaluate(() => window.scrollBy(0, 120));
  await snap(p3, '30-crear-enlace-no-disponible', { theme });
  await ctx3.close();
  // Revisión: hoja de otra persona (aviso naranja)
  const p4 = await open(_ctx, { state: demoState() });
  await p4.evaluate((r) => window.__turnosTest.injectScanResult(r), {
    layout: 'pc-table', month: 11, year: 2026, days: [{ day: 2, codes: ['F1'], confidence: 0.4 }, { day: 3, codes: ['S1'], confidence: 0.4 }, { day: 4, codes: ['-'], confidence: 0.4 }],
    warnings: ['Esta hoja parece de otra persona: no veo «Mauricio» en el nombre. Revisa antes de guardar.'],
  });
  await p4.waitForSelector('.review-list');
  await snap(p4, '30-revision-otra-hoja', { theme });
  return p4;
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
    if (only && (only === 'responsive' || !sc.name.includes(only))) continue;
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

// Tamaños de SPEC §14: pantallas clave, desbordamientos y ancho de la columna central
const SIZES = [
  { id: 'a360', width: 360, height: 740, device: 'android', themes: ['light', 'dark'], scale: 2 },
  { id: 'i390', width: 390, height: 844, device: 'iphone', themes: ['light', 'dark'], scale: 2 },
  { id: 'i430', width: 430, height: 932, device: 'iphone', themes: ['light', 'dark'], scale: 2 },
  { id: 't820', width: 820, height: 1180, device: 'ipad', themes: ['light'], scale: 1 },
  { id: 't1180', width: 1180, height: 820, device: 'ipad', themes: ['light'], scale: 1 },
  { id: 'd1280', width: 1280, height: 800, device: 'desktop', themes: ['light', 'dark'], scale: 1 },
];
if (!only || only === 'responsive' || only === 'overflow') {
  for (const size of SIZES) {
    for (const theme of themes.filter((t) => size.themes.includes(t))) {
      const ctx = await iphoneContext(browser, { theme, width: size.width, height: size.height, scale: size.scale, device: size.device });
      const page = await open(ctx, { state: richState({ sync: true, ntfy: true }), standalone: size.device !== 'android' });
      const name = (n) => `r-${size.id}-${n}`;
      const check = async (where) => { for (const o of await findOverflow(page)) problems.push(`[${size.id} ${where}] ${o}`); };
      for (const t of ['hoy', 'calendario', 'escanear', 'horas', 'ajustes']) {
        await tab(page, t);
        await page.waitForTimeout(200);
        if (t === 'ajustes') {
          await page.click('#set-advanced > summary');
          await page.click('[data-testid="payroll"] > summary');
          await page.waitForTimeout(150);
        }
        await check(t);
        await snap(page, name(t), { theme });
        if (t !== 'escanear') await snap(page, name(`${t}-completo`), { theme, full: true });
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      // Columna central y barra de pestañas: centradas y sin estirarse en pantallas anchas
      const layout = await page.evaluate(() => {
        const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
        const v = r('#views'), t = r('.tabbar');
        return { vw: innerWidth, views: [Math.round(v.left), Math.round(v.right)], tabbar: [Math.round(t.left), Math.round(t.right)] };
      });
      if (size.width >= 700) {
        const w = layout.views[1] - layout.views[0];
        if (w > 740) problems.push(`[${size.id}] la columna mide ${w} px (máx. ~720)`);
        if (Math.abs(layout.views[0] - (layout.vw - layout.views[1])) > 2) problems.push(`[${size.id}] la columna no está centrada ${JSON.stringify(layout)}`);
        if (Math.abs(layout.tabbar[0] - (layout.vw - layout.tabbar[1])) > 2 || layout.tabbar[1] - layout.tabbar[0] > 600) problems.push(`[${size.id}] la barra de pestañas no está centrada ${JSON.stringify(layout)}`);
      }
      // Septiembre: el mes más largo y la semana entre dos meses («31 ago – 6 sept»)
      await tab(page, 'calendario');
      await page.click('[aria-label="Mes anterior"]');
      await page.waitForTimeout(150);
      await check('calendario-septiembre');
      await snap(page, name('calendario-septiembre'), { theme });
      await page.click('[aria-label="Mes siguiente"]');
      // Hoja (editar día) y diálogo
      await tab(page, 'calendario');
      await page.click('.day-row[data-key="2026-10-26"]');
      await page.waitForSelector('.sheet-wrap.open');
      await page.waitForTimeout(420);
      await check('editar-dia');
      await snap(page, name('editar-dia'), { theme });
      const sh = await page.evaluate(() => { const b = document.querySelector('.sheet').getBoundingClientRect(); return { l: b.left, r: b.right, vw: innerWidth }; });
      if (size.width >= 700 && (sh.r - sh.l > 640 || Math.abs(sh.l - (sh.vw - sh.r)) > 2)) problems.push(`[${size.id}] la hoja no está centrada ${JSON.stringify(sh)}`);
      await page.click('.sheet .tile[data-code="S1"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dialog-wrap.open');
      await page.waitForTimeout(250);
      await snap(page, name('dialogo'), { theme });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.dialog-wrap.open');
      await page.click('.dialog-wrap.open .btn-danger');
      await page.waitForSelector('.sheet-wrap', { state: 'detached' });
      // Revisión de un escaneo
      await page.evaluate((r) => window.__turnosTest.injectScanResult(r), HARD_RESULT);
      await page.waitForSelector('.review-list');
      await page.selectOption('.review-month select >> nth=0', '11');
      await page.waitForTimeout(400);
      await check('revision');
      await snap(page, name('revision'), { theme });
      for (const e of page.__errors) problems.push(`[${size.id}/${theme}] ${e}`);
      await ctx.close();
      // Bienvenida (paso del nombre)
      const ctx2 = await iphoneContext(browser, { theme, width: size.width, height: size.height, scale: size.scale, device: size.device });
      const p2 = await open(ctx2, { state: null, standalone: true });
      await p2.waitForSelector('.onboarding.open');
      await p2.click('.ob-bottom .btn-primary');
      await p2.waitForTimeout(300);
      for (const o of await findOverflow(p2)) problems.push(`[${size.id} bienvenida] ${o}`);
      await snap(p2, name('bienvenida-nombre'), { theme });
      for (const e of p2.__errors) problems.push(`[${size.id}/${theme} bienvenida] ${e}`);
      await ctx2.close();
    }
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
