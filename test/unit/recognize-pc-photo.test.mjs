// La tabla del PC con la foto real (test/fotos/pc-2026-06.jpg, impresión filtrada de «Ducuara Mauricio»)
// y el nombre del plan (employeeName), en Chromium: el eval nunca pasa employeeName (SPEC §11).
// Si Playwright o Chromium no están, el test se salta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../tools/serve.mjs';

const LOW_CONFIDENCE = 0.7; // docs/js/ui/scan.js: por debajo, la revisión no marca el día

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { chromium = null; }

test('foto real del PC: la hoja de Mauricio leída por Ana queda «por revisar»; la suya, igual que siempre', { skip: !chromium && 'sin Playwright', timeout: 240000 }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip(`sin Chromium: ${e.message.split('\n')[0]}`); return; }
  const server = await startServer(0);
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/test/lab/harness.html`);
    const read = (employeeName) => page.evaluate(async ([impl, photo, name]) => {
      const mod = await import(impl);
      const blob = await (await fetch(photo)).blob();
      const r = await mod.recognize(blob, { tesseract: window.TESS_PATHS, employeeName: name });
      return { layout: r.layout, month: r.month, year: r.year, days: r.days, warnings: r.warnings };
    }, [`${server.url}/docs/js/recognize/index.js`, `${server.url}/test/fotos/pc-2026-06.jpg`, employeeName]);

    const own = await read('Ducuara Mauricio');
    assert.deepEqual([own.layout, own.month, own.year, own.days.length], ['pc-grid', 6, 2026, 30]);
    assert.ok(!own.warnings.some((w) => /otra persona|Revisa que el plan/.test(w)), own.warnings.join(' | '));
    assert.ok(own.days.filter((d) => d.confidence >= LOW_CONFIDENCE).length >= 20, 'la mayoría se marcan solos');

    const ana = await read('Ducuara Ana');
    assert.equal(ana.layout, 'pc-grid');
    assert.equal(ana.days.length, 30, 'se leen (por si de verdad es su hoja), pero…');
    assert.ok(ana.days.every((d) => d.confidence < LOW_CONFIDENCE), '…ninguno se marca solo');
    assert.ok(ana.warnings.includes('Esta hoja parece de otra persona: no veo «Ana» en el nombre. Revisa antes de guardar.'), ana.warnings.join(' | '));
    // Mismos turnos que con su nombre (solo cambia la confianza)
    assert.deepEqual(ana.days.map((d) => [d.day, d.codes]), own.days.map((d) => [d.day, d.codes]));
  } finally {
    await browser.close();
    await server.close();
  }
});
