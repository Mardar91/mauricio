// Pool de workers de Tesseract (se reutilizan entre llamadas; dispose() los termina).

const pool = { workers: [], busy: [], params: [], queue: [], key: '', creating: null };

export async function ensureWorkers(paths = {}, n = 2) {
  const key = JSON.stringify([paths.workerPath, paths.corePath, paths.langPath]);
  if (pool.creating) await pool.creating;
  if (pool.workers.length && pool.key === key) return;
  pool.creating = (async () => {
    await disposeWorkers();
    const T = globalThis.Tesseract;
    if (!T || !T.createWorker) throw new Error('Tesseract no está cargado');
    const opts = {};
    for (const k of ['workerPath', 'corePath', 'langPath']) if (paths[k]) opts[k] = paths[k];
    // OEM 1 = LSTM (best_int)
    const ws = await Promise.all(Array.from({ length: n }, () => T.createWorker('eng', 1, opts)));
    pool.workers = ws; pool.busy = ws.map(() => false); pool.params = ws.map(() => ''); pool.key = key;
  })();
  try { await pool.creating; } finally { pool.creating = null; }
}

export async function disposeWorkers() {
  const ws = pool.workers; pool.workers = []; pool.busy = []; pool.params = []; pool.key = '';
  for (const j of pool.queue.splice(0)) j.reject(new Error('OCR cancelado'));
  await Promise.all(ws.map((w) => w.terminate().catch(() => {})));
}

function pump() {
  while (pool.queue.length) {
    const i = pool.busy.findIndex((b) => !b);
    if (i < 0) return;
    const job = pool.queue.shift(); pool.busy[i] = true;
    run(i, job).then(job.resolve, job.reject).finally(() => { pool.busy[i] = false; pump(); });
  }
}

async function run(i, job) {
  const w = pool.workers[i];
  const p = { tessedit_pageseg_mode: String(job.psm), tessedit_char_whitelist: job.whitelist || '' };
  const pk = JSON.stringify(p);
  if (pool.params[i] !== pk) { await w.setParameters(p); pool.params[i] = pk; }
  const { data } = await w.recognize(job.image, {}, { blocks: true, text: true });
  return parse(data);
}

// OCR de un lienzo. Devuelve { text, conf, words: [{text, conf, bbox, symbols: [{text, conf, bbox}]}] }
export function ocr(image, { psm = 7, whitelist = '' } = {}) {
  if (!pool.workers.length) return Promise.reject(new Error('OCR no inicializado'));
  return new Promise((resolve, reject) => { pool.queue.push({ image, psm, whitelist, resolve, reject }); pump(); });
}

function parse(data) {
  const words = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
    words.push({ text: wd.text, conf: wd.confidence, bbox: wd.bbox, symbols: (wd.symbols || []).map((s) => ({ text: s.text, conf: s.confidence, bbox: s.bbox })) });
  }
  return { text: (data.text || '').trim(), conf: data.confidence ?? 0, words };
}
