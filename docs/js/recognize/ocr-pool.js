// Pool compartido de workers de Tesseract (OEM 1 = LSTM, best_int) para los tres lectores.
// Cada trabajo fija TODOS los parámetros que usan los lectores (PSM, lista blanca y DPI) antes de leer:
// así un worker se comparte sin que un lector herede los ajustes de otro.
// Arranque: tesseract.js 7 no rechaza createWorker si falla la descarga del idioma (se queda colgado), así que
// cada arranque compite con errorHandler y con un tiempo máximo; si falla, el worker a medias se termina y el
// error se recuerda un rato (las demás fotos de la tanda fallan enseguida, sin volver a esperar).
// Época: sube con cada dispose(); una lectura empezada antes ya no puede usar ni volver a crear workers.

const DEFAULT_PARAMS = { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '', user_defined_dpi: '0' };
const START_ERROR_TTL = 30000; // ms que se recuerda un fallo de arranque (o hasta dispose)

const pool = {
  key: '',          // rutas de los workers actuales
  size: 1,          // nº máximo de workers
  slots: [],        // [{ worker, params, busy, job }]
  creating: null,   // promesa de creación en curso
  queue: [],        // trabajos en espera
  gen: 0,           // sube con dispose() o con rutas nuevas: invalida creaciones en curso
  epoch: 0,         // sube solo con dispose(): invalida las lecturas empezadas antes
  starting: new Set(), // arranques en curso: { abort(err) }
  startError: null, // { key, error, at }: último fallo de arranque
  startTimeout: 45000, // ms; la primera descarga (≈ 7 MB) con datos móviles lentos
};

// Rutas por defecto: docs/vendor/tesseract/ (relativas a este módulo)
export function defaultPaths() {
  const base = new URL('../../vendor/tesseract/', import.meta.url).href;
  return { workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang/best_int/' };
}

// Solo estas tres rutas (langPathLegacy y otras claves se ignoran)
function normPaths(tess) {
  const out = defaultPaths();
  if (tess) for (const k of ['workerPath', 'corePath', 'langPath']) if (tess[k]) out[k] = String(tess[k]);
  return out;
}
const keyOf = (tess) => JSON.stringify(normPaths(tess));

const cancelled = () => Object.assign(new Error('OCR cancelado'), { code: 'cancelado' });
// ¿Lectura de una época anterior a dispose()? (tess.epoch lo pone index.js; los lectores sueltos no lo llevan)
const isStale = (tess) => !!tess && tess.epoch != null && tess.epoch !== pool.epoch;

// Nº de workers (1 por defecto: menos memoria en iPhone). Se aplica al crear el pool.
export function setPoolSize(n) {
  pool.size = Math.max(1, Math.min(4, Math.round(Number(n) || 1)));
}

// Tiempo máximo de arranque de un worker (ms)
export function setStartTimeout(ms) {
  const n = Number(ms);
  if (Number.isFinite(n) && n > 0) pool.startTimeout = Math.round(n);
}

export function poolEpoch() { return pool.epoch; }

// Error de arranque recordado para estas rutas (o null)
export function startErrorFor(tess) {
  const e = pool.startError;
  if (!e) return null;
  if (Date.now() - e.at > START_ERROR_TTL) { pool.startError = null; return null; }
  return e.key === keyOf(tess) ? e.error : null;
}

// Arranca (o reutiliza) los workers con estas rutas. Resuelve cuando están listos.
export function ready(tess) {
  if (isStale(tess)) return Promise.reject(cancelled());
  const paths = normPaths(tess);
  const key = JSON.stringify(paths);
  const failed = startErrorFor(tess);
  if (failed) return Promise.reject(failed);
  if (pool.key && pool.key !== key) terminateAll(new Error('Rutas de Tesseract cambiadas'));
  if (pool.key === key && pool.slots.length) return Promise.resolve(pool.slots);
  if (pool.key === key && pool.creating) return pool.creating;
  const T = globalThis.Tesseract;
  if (!T || !T.createWorker) return Promise.reject(new Error('Tesseract no está cargado'));
  pool.key = key;
  const gen = pool.gen;
  const p = (async () => {
    const res = await Promise.allSettled(Array.from({ length: pool.size }, () => startWorker(T, paths)));
    const ws = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (gen !== pool.gen || pool.key !== key) {
      // dispose() o cambio de rutas mientras se creaban
      ws.forEach(stopWorker);
      throw cancelled();
    }
    if (!ws.length) {
      const err = (res[0] && res[0].reason) || new Error('No se pudo iniciar el OCR');
      pool.key = '';
      pool.startError = { key, error: err, at: Date.now() };
      throw err;
    }
    pool.startError = null;
    pool.slots = ws.map((worker) => ({ worker, params: {}, busy: false, job: null }));
    return pool.slots;
  })();
  pool.creating = p;
  p.then(() => { if (pool.creating === p) pool.creating = null; }, () => { if (pool.creating === p) pool.creating = null; });
  return p;
}

function stopWorker(w) {
  try { Promise.resolve(w && w.terminate()).catch(() => {}); } catch (e) { /* nada */ }
}

// Crea un worker: compite con errorHandler (fallo al cargar el idioma) y con el tiempo máximo.
// Si no llega a estar listo, se termina el Worker a medias (capturado al construirse).
function startWorker(T, paths) {
  return new Promise((resolve, reject) => {
    let raw = null; let done = false; let timer = null;
    const entry = {};
    const end = (err, w) => {
      if (done) { if (w) stopWorker(w); return; }
      done = true; clearTimeout(timer); pool.starting.delete(entry);
      if (!err) { resolve(w); return; }
      if (w) stopWorker(w);
      if (raw) { try { raw.terminate(); } catch (e) { /* nada */ } }
      reject(err instanceof Error ? err : new Error(String(err || 'OCR')));
    };
    entry.abort = (err) => end(err);
    pool.starting.add(entry);
    // workerBlobURL: false → el worker es una URL del mismo origen (el service worker la sirve sin conexión)
    const opts = { ...paths, workerBlobURL: false, logger: () => {}, errorHandler: (e) => end(new Error('OCR: ' + String(e))) };
    let p;
    const W0 = globalThis.Worker;
    try {
      // createWorker construye el Worker de forma síncrona: se captura para poder terminarlo
      if (typeof W0 === 'function') globalThis.Worker = class extends W0 { constructor(...a) { super(...a); raw = this; } };
      p = T.createWorker('eng', 1, opts);
    } catch (e) {
      p = Promise.reject(e);
    } finally {
      if (typeof W0 === 'function') globalThis.Worker = W0;
    }
    timer = setTimeout(() => end(new Error(`OCR: sin respuesta en ${Math.round(pool.startTimeout / 1000)} s`)), pool.startTimeout);
    Promise.resolve(p).then(async (w) => {
      if (done) { stopWorker(w); return; }
      // los avisos internos de Tesseract ("Bottom=0, top=…") salían como errores en la consola
      try { await w.setParameters({ debug_file: '/dev/null' }); } catch (e) { /* nada */ }
      end(null, w);
    }, (e) => end(e || new Error('No se pudo iniciar el OCR')));
  });
}

// Arranca los workers en segundo plano (sin esperar)
export function prewarm(tess) { ready(tess).catch(() => {}); }

// OCR de una imagen (lienzo). params: { psm, whitelist, dpi }; output: opciones de salida de tesseract.js.
// Devuelve el `data` de tesseract.js.
export function recognizeImage(tess, image, { psm = 7, whitelist = '', dpi = '0' } = {}, output = { text: true, blocks: true }) {
  if (isStale(tess)) return Promise.reject(cancelled());
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

// Lienzo → bytes PNG (lo mismo que haría tesseract.js por dentro, pero aquí: así dispose() no le pilla
// convirtiendo la imagen con el worker ya terminado). Blob → bytes; lo demás se pasa tal cual.
async function toBytes(image) {
  let blob = null;
  if (image && typeof image.convertToBlob === 'function') blob = await image.convertToBlob();
  else if (image && typeof image.toBlob === 'function') blob = await new Promise((r) => image.toBlob(r));
  else if (typeof Blob !== 'undefined' && image instanceof Blob) blob = image;
  else return image;
  if (!blob) throw new Error('OCR: no se pudo leer el lienzo');
  return typeof blob.arrayBuffer === 'function' ? blob.arrayBuffer() : new Response(blob).arrayBuffer();
}

// Llamada a tesseract.js: si el worker se termina antes de que responda, su promesa no debe quedar sin capturar
function call(p) {
  Promise.resolve(p).catch(() => {});
  return p;
}

async function runOn(s, job) {
  s.busy = true; s.job = job;
  // ¿sigue siendo este el trabajo del worker? (dispose() o rutas nuevas lo terminan)
  const current = () => s.job === job && pool.slots.includes(s);
  try {
    const image = await toBytes(job.image);
    if (!current()) return;
    const diff = {};
    for (const k of Object.keys(job.params)) if (s.params[k] !== job.params[k]) diff[k] = job.params[k];
    if (Object.keys(diff).length) {
      s.params = {}; // si falla a medias, se vuelven a fijar todos
      await call(s.worker.setParameters(diff));
      if (!current()) return;
      s.params = { ...job.params };
    }
    // con bytes, tesseract.js envía el trabajo en el microtask siguiente: antes que el terminate() diferido de terminateAll
    const { data } = await call(s.worker.recognize(image, {}, job.output));
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
  for (const st of [...pool.starting]) st.abort(err);
  return Promise.all(slots.map((s) => Promise.resolve().then(() => s.worker.terminate()).catch(() => {})));
}

// Termina todos los workers (libera la memoria del iPhone). Los trabajos pendientes fallan, los arranques en
// curso se cortan y se olvida el último fallo de arranque. Siempre termina en ≤ 2 s.
export async function disposePool() {
  pool.epoch++;
  pool.startError = null;
  const done = terminateAll(cancelled());
  let timer = null;
  await Promise.race([done, new Promise((r) => { timer = setTimeout(r, 2000); })]);
  clearTimeout(timer);
}

// Estado (para pruebas)
export function poolInfo() {
  return { workers: pool.slots.length, size: pool.size, queued: pool.queue.length, creating: !!pool.creating, starting: pool.starting.size, epoch: pool.epoch, startError: pool.startError ? String(pool.startError.error && pool.startError.error.message) : null };
}
