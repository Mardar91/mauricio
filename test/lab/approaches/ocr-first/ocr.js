// Pool de workers de Tesseract (reutilizados entre llamadas). Cada trabajo fija sus parámetros.

const pool = { workers: [], busy: [], params: [], queue: [], creating: null, key: '' };

export async function ensureWorkers(paths, n = 2) {
  const key = JSON.stringify(paths || {});
  if (pool.workers.length && pool.key === key) return;
  if (pool.creating) { await pool.creating; if (pool.workers.length && pool.key === key) return; }
  pool.creating = (async () => {
    await disposeWorkers();
    const T = globalThis.Tesseract;
    if (!T || !T.createWorker) throw new Error('Tesseract no está cargado');
    const opts = {};
    if (paths) for (const k of ['workerPath', 'corePath', 'langPath']) if (paths[k]) opts[k] = paths[k];
    // OEM 1 = LSTM (best_int). Se crean en paralelo.
    const ws = await Promise.all(Array.from({ length: n }, () => T.createWorker('eng', 1, opts)));
    pool.workers = ws; pool.busy = ws.map(() => false); pool.params = ws.map(() => ''); pool.key = key;
  })();
  try { await pool.creating; } finally { pool.creating = null; }
}

export async function disposeWorkers() {
  const ws = pool.workers; pool.workers = []; pool.busy = []; pool.params = []; pool.queue = [];
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
  const p = { tessedit_pageseg_mode: String(job.psm || 11), tessedit_char_whitelist: job.whitelist || '', preserve_interword_spaces: '0' };
  const pk = JSON.stringify(p);
  if (pool.params[i] !== pk) { await w.setParameters(p); pool.params[i] = pk; }
  const { data } = await w.recognize(job.image, job.rectangle ? { rectangle: job.rectangle } : {}, { blocks: true, text: false });
  return parseWords(data);
}

// Reconoce una imagen (canvas) y devuelve palabras con caja, confianza y símbolos.
export function ocr(image, { psm = 11, whitelist = '', rectangle = null } = {}) {
  return new Promise((resolve, reject) => { pool.queue.push({ image, psm, whitelist, rectangle, resolve, reject }); pump(); });
}

function parseWords(data) {
  const out = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const wd of l.words || []) {
          const bb = wd.bbox;
          out.push({
            text: wd.text, conf: wd.confidence, x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1,
            line: { x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 },
            syms: (wd.symbols || []).map((s) => ({ text: s.text, conf: s.confidence, x0: s.bbox.x0, y0: s.bbox.y0, x1: s.bbox.x1, y1: s.bbox.y1 })),
            choices: wd.choices || null,
          });
        }
      }
    }
  }
  return out;
}
