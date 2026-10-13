// Pool compartido de workers de Tesseract (OEM 1 = LSTM, best_int) para los tres lectores.
// Cada trabajo fija TODOS los parámetros que usan los lectores (PSM, lista blanca y DPI) antes de leer:
// así un worker se comparte sin que un lector herede los ajustes de otro.

const DEFAULT_PARAMS = { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '', user_defined_dpi: '0' };

const pool = {
  key: '',          // rutas de los workers actuales
  size: 1,          // nº máximo de workers
  slots: [],        // [{ worker, params, busy, job }]
  creating: null,   // promesa de creación en curso
  queue: [],        // trabajos en espera
  gen: 0,           // sube con cada dispose(): invalida creaciones en curso
};

// Rutas por defecto: docs/vendor/tesseract/ (relativas a este módulo)
export function defaultPaths() {
  const base = new URL('../../vendor/tesseract/', import.meta.url).href;
  return { workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang/best_int/' };
}

function normPaths(tess) {
  const out = defaultPaths();
  if (tess) for (const k of ['workerPath', 'corePath', 'langPath']) if (tess[k]) out[k] = String(tess[k]);
  return out;
}

// Nº de workers (1 por defecto: menos memoria en iPhone). Se aplica al crear el pool.
export function setPoolSize(n) {
  pool.size = Math.max(1, Math.min(4, Math.round(Number(n) || 1)));
}

// Arranca (o reutiliza) los workers con estas rutas. Resuelve cuando están listos.
export function ready(tess) {
  const paths = normPaths(tess);
  const key = JSON.stringify(paths);
  if (pool.key && pool.key !== key) terminateAll(new Error('Rutas de Tesseract cambiadas'));
  if (pool.key === key && pool.slots.length) return Promise.resolve(pool.slots);
  if (pool.key === key && pool.creating) return pool.creating;
  pool.key = key;
  const gen = pool.gen;
  const T = globalThis.Tesseract;
  if (!T || !T.createWorker) { pool.key = ''; return Promise.reject(new Error('Tesseract no está cargado')); }
  const opts = { ...paths, logger: () => {}, errorHandler: () => {} };
  const p = (async () => {
    const res = await Promise.allSettled(Array.from({ length: pool.size }, async () => {
      const w = await T.createWorker('eng', 1, opts);
      // los avisos internos de Tesseract ("Bottom=0, top=…") salían como errores en la consola
      try { await w.setParameters({ debug_file: '/dev/null' }); } catch (e) { /* nada */ }
      return w;
    }));
    const ws = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (gen !== pool.gen || pool.key !== key) {
      // dispose() o cambio de rutas mientras se creaban
      await Promise.all(ws.map((w) => w.terminate().catch(() => {})));
      throw new Error('OCR cancelado');
    }
    if (!ws.length) { pool.key = ''; throw (res[0] && res[0].reason) || new Error('No se pudo iniciar el OCR'); }
    pool.slots = ws.map((worker) => ({ worker, params: {}, busy: false, job: null }));
    return pool.slots;
  })();
  pool.creating = p;
  p.then(() => { if (pool.creating === p) pool.creating = null; }, () => { if (pool.creating === p) pool.creating = null; });
  return p;
}

// Arranca los workers en segundo plano (sin esperar)
export function prewarm(tess) { ready(tess).catch(() => {}); }

// OCR de una imagen (lienzo). params: { psm, whitelist, dpi }; output: opciones de salida de tesseract.js.
// Devuelve el `data` de tesseract.js.
export function recognizeImage(tess, image, { psm = 7, whitelist = '', dpi = '0' } = {}, output = { text: true, blocks: true }) {
  const params = { ...DEFAULT_PARAMS, tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist || '', user_defined_dpi: String(dpi || '0') };
  return new Promise((resolve, reject) => {
    pool.queue.push({ tess, image, params, output, resolve, reject });
    pump();
  });
}

function pump() {
  if (!pool.queue.length) return;
  const gen = pool.gen;
  ready(pool.queue[0].tess).then((slots) => {
    if (gen !== pool.gen) return;
    for (const s of slots) {
      if (!pool.queue.length) break;
      if (!s.busy) runOn(s, pool.queue.shift());
    }
  }, (e) => {
    if (gen !== pool.gen) return;
    for (const j of pool.queue.splice(0)) j.reject(e);
  });
}

async function runOn(s, job) {
  s.busy = true; s.job = job;
  try {
    const diff = {};
    for (const k of Object.keys(job.params)) if (s.params[k] !== job.params[k]) diff[k] = job.params[k];
    if (Object.keys(diff).length) {
      s.params = {}; // si falla a medias, se vuelven a fijar todos
      await s.worker.setParameters(diff);
      s.params = { ...job.params };
    }
    const { data } = await s.worker.recognize(job.image, {}, job.output);
    if (s.job === job) job.resolve(data);
  } catch (e) {
    s.params = {};
    if (s.job === job) job.reject(e);
  } finally {
    if (s.job === job) { s.busy = false; s.job = null; }
    pump();
  }
}

function terminateAll(err) {
  pool.gen++;
  const slots = pool.slots;
  pool.slots = []; pool.key = ''; pool.creating = null;
  for (const j of pool.queue.splice(0)) j.reject(err);
  for (const s of slots) { if (s.job) { const j = s.job; s.job = null; j.reject(err); } }
  return Promise.all(slots.map((s) => Promise.resolve().then(() => s.worker.terminate()).catch(() => {})));
}

// Termina todos los workers (libera la memoria del iPhone). Los trabajos pendientes fallan.
export async function disposePool() {
  const creating = pool.creating;
  await terminateAll(new Error('OCR cancelado'));
  if (creating) await creating.catch(() => {});
}

// Estado (para pruebas)
export function poolInfo() {
  return { workers: pool.slots.length, size: pool.size, queued: pool.queue.length, creating: !!pool.creating };
}
