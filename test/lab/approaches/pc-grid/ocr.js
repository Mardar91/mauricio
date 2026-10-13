// OCR con Tesseract: un worker LSTM reutilizable entre llamadas.

let workerP = null; let workerKey = ''; let params = {};

export async function getWorker(tess) {
  const T = globalThis.Tesseract;
  if (!T || !T.createWorker) throw new Error('Tesseract no está cargado');
  const key = JSON.stringify(tess || {});
  if (workerP && workerKey === key) return workerP;
  if (workerP) await disposeOcr();
  workerKey = key; params = {};
  const o = { logger: () => {}, errorHandler: () => {} };
  if (tess) for (const k of ['workerPath', 'corePath', 'langPath']) if (tess[k]) o[k] = tess[k];
  workerP = T.createWorker('eng', 1, o).catch((e) => { workerP = null; throw e; });
  return workerP;
}

export async function disposeOcr() {
  const p = workerP; workerP = null; params = {};
  if (p) { try { const w = await p; await w.terminate(); } catch (e) { /* nada */ } }
}

// Arranca el worker en segundo plano (sin esperar)
export function prewarm(tess) { getWorker(tess).catch(() => {}); }

// Cola: Tesseract procesa un trabajo a la vez por worker
let chain = Promise.resolve();

// Reconoce un lienzo. Devuelve { text, conf, words:[{text, conf, x0,y0,x1,y1, syms}] }
export function ocr(tess, canvas, { psm = 7, whitelist = '', dpi = '300' } = {}) {
  const job = chain.then(async () => {
    const w = await getWorker(tess);
    const want = { tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist, user_defined_dpi: dpi };
    const diff = {}; for (const k of Object.keys(want)) if (params[k] !== want[k]) diff[k] = want[k];
    if (Object.keys(diff).length) { await w.setParameters(diff); Object.assign(params, diff); }
    const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
      words.push({ text: wd.text, conf: wd.confidence, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1,
        syms: (wd.symbols || []).map((s) => ({ text: s.text, conf: s.confidence, choices: s.choices || null, x0: s.bbox.x0, x1: s.bbox.x1 })) });
    }
    return { text: (data.text || '').trim(), conf: data.confidence || 0, words };
  });
  chain = job.catch(() => {});
  return job;
}
