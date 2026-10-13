// Capturas de todas las vistas (iPhone 390×844 @3x, claro y oscuro) en test/e2e/out/ para revisar el diseño.
// También comprueba que nada se sale por los lados a 360 px.
// Uso: node test/e2e/screens.mjs [--only nombre] [--theme light|dark] [--scale 3]
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tools/serve.mjs';
import { NOW, OUT, core, demoState, ensureOut, findOverflow, iphoneContext, mockNetwork, preparePage } from './helpers.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', '');
const themes = opt('theme', '') ? [opt('theme')] : ['light', 'dark'];
const scale = Number(opt('scale', 3));

ensureOut();
const server = await startServer(0);
const APP = `${server.url}/docs/`;
const PHOTO = path.join(process.cwd(), 'test/fotos/phone-2026-10-b.jpg');
const browser = await chromium.launch({ args: ['--lang=es-ES'] });
const problems = [];

// Reconocedor lento de mentira para capturar el progreso
const SLOW_RECOGNIZER = `export async function recognize(input, o = {}) {
  for (let i = 1; i <= 20; i++) { await new Promise((r) => setTimeout(r, 120)); o.onProgress?.(i / 20, i < 8 ? 'Buscando el mes…' : 'Leyendo los turnos…'); }
  return { layout: 'unknown', month: null, year: null, days: [], warnings: [] };
}
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

const scenarios = [];
const scenario = (name, fn, opts = {}) => scenarios.push({ name, fn, opts });

async function snap(page, name, { full = false, theme } = {}) {
  await page.waitForTimeout(450);
  const file = path.join(OUT, `${name}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: full });
  return file;
}

async function open(context, { state, now = NOW } = {}) {
  const errors = [];
  const page = await preparePage(context, { state, now, errors });
  await mockNetwork(page);
  await page.goto(APP);
  await page.waitForSelector('.tabbar');
  await page.waitForTimeout(300);
  page.__errors = errors;
  return page;
}

const tab = (page, id) => page.click(`.tab[data-tab="${id}"]`);

scenario('onboarding', async (ctx, theme) => {
  const page = await open(ctx, { state: null });
  await page.waitForSelector('.onboarding.open');
  await snap(page, '01-onboarding-1', { theme });
  await page.click('.ob-bottom .btn-primary');
  await snap(page, '01-onboarding-2', { theme });
  await page.click('.ob-bottom .btn-primary');
  await snap(page, '01-onboarding-3', { theme });
  await page.click('.ob-bottom .btn-primary');
  await page.waitForTimeout(400);
  await snap(page, '02-escanear-tras-bienvenida', { theme });
  return page;
});

scenario('hoy-vacio', async (ctx, theme) => {
  const s = core.updateSettings(core.createDefaultState(), { onboardingDone: true });
  const page = await open(ctx, { state: s });
  await snap(page, '03-hoy-vacio', { theme });
  return page;
});

scenario('hoy', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await snap(page, '04-hoy', { theme });
  await snap(page, '04-hoy-completo', { theme, full: true });
  return page;
});

scenario('hoy-trabajando', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState({ sync: true }), now: new Date('2026-10-13T17:40:00+02:00') });
  await snap(page, '05-hoy-trabajando', { theme });
  return page;
});

scenario('hoy-noche', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState({ sync: true }), now: new Date('2026-10-16T19:05:00+02:00') });
  await snap(page, '05-hoy-libre-noche', { theme });
  return page;
});

scenario('calendario', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'calendario');
  await snap(page, '06-calendario', { theme });
  await page.evaluate(() => window.scrollTo(0, 0));
  await snap(page, '06-calendario-arriba', { theme });
  await snap(page, '06-calendario-completo', { theme, full: true });
  for (let i = 0; i < 4; i++) await page.click('button[aria-label="Mes anterior"]');
  await snap(page, '07-calendario-junio', { theme, full: true });
  return page;
});

scenario('editar-dia', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'calendario');
  await page.click('.day-row[data-key="2026-10-15"]');
  await page.waitForSelector('.sheet-wrap.open');
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
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.click('.sheet-day .btn-danger-plain');
  await snap(page, '10-confirmar-borrar', { theme });
  await page.click('.dialog .btn-secondary');
  await page.click('.tile[data-code="F1"]');
  await page.click('.sheet-day .btn-primary');
  await page.waitForSelector('.toast.show');
  await snap(page, '11-guardado-toast', { theme });
  return page;
});

scenario('escanear', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'escanear');
  await snap(page, '12-escanear', { theme });
  await page.route('**/docs/js/recognize/index.js', (r) => r.fulfill({ contentType: 'text/javascript', body: SLOW_RECOGNIZER }));
  await page.setInputFiles('input[data-testid="scan-pick"]', [PHOTO, path.join(process.cwd(), 'test/fotos/phone-2026-10-a.jpg')]);
  await page.waitForSelector('.photo-item');
  await page.waitForTimeout(1600);
  await snap(page, '13-escanear-leyendo', { theme });
  await page.waitForSelector('.fallback', { timeout: 15000 });
  await snap(page, '14-escanear-no-leido', { theme });
  await page.selectOption('.fallback .month-picker select >> nth=0', '10');
  await page.click('.fallback-card .btn-primary');
  await page.waitForSelector('.review-list');
  await page.click('.review-row[data-day="22"] .review-main');
  await page.waitForSelector('.sheet-wrap.open');
  await page.click('.tile[data-code="N1"]');
  await snap(page, '15-a-mano-editor', { theme });
  await page.click('.sheet-day .btn-primary');
  await page.waitForTimeout(300);
  await snap(page, '15-a-mano', { theme });
  return page;
});

scenario('revision', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await page.evaluate((r) => window.__turnosTest.injectScanResult(r), FAKE_RESULT);
  await page.waitForSelector('.review-list');
  await snap(page, '16-revision', { theme });
  await snap(page, '16-revision-completa', { theme, full: true });
  return page;
});

scenario('horas', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'horas');
  await snap(page, '17-horas', { theme });
  await snap(page, '17-horas-completo', { theme, full: true });
  return page;
});

scenario('ajustes', async (ctx, theme) => {
  const s = demoState({ sync: true, ntfy: true });
  const page = await open(ctx, { state: s });
  await tab(page, 'ajustes');
  await snap(page, '18-ajustes', { theme });
  await page.click('details[data-fkey="guide-cal"] summary');
  await page.click('details[data-fkey="guide-ntfy"] summary');
  await snap(page, '18-ajustes-completo', { theme, full: true });
  await page.click('.code-row[data-code="F6"]');
  await page.waitForSelector('.sheet-wrap.open');
  await snap(page, '19-codigo-sin-confirmar', { theme });
  return page;
});

scenario('ajustes-sin-sync', async (ctx, theme) => {
  const page = await open(ctx, { state: demoState() });
  await tab(page, 'ajustes');
  await page.evaluate(() => document.getElementById('set-calendar').scrollIntoView());
  await snap(page, '20-ajustes-calendario-sin-config', { theme });
  return page;
});

scenario('setup', async (ctx, theme) => {
  const errors = [];
  const page = await preparePage(ctx, { state: demoState(), errors });
  await mockNetwork(page);
  const link = core.buildSetupLink(APP, { owner: 'Mardar91', repo: 'mauricio', token: 'github_pat_x', branch: 'datos' });
  await page.goto(link);
  await page.waitForSelector('.dialog-wrap.open');
  await snap(page, '21-enlace-setup', { theme });
  page.__errors = errors;
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
    const ctx = await iphoneContext(browser, { width, height: 740, scale: 1 });
    const page = await open(ctx, { state: demoState({ sync: true, ntfy: true }) });
    for (const t of ['hoy', 'calendario', 'escanear', 'horas', 'ajustes']) {
      await tab(page, t);
      await page.waitForTimeout(200);
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
    await page.evaluate((r) => window.__turnosTest.injectScanResult(r), FAKE_RESULT);
    await page.waitForSelector('.review-list');
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
