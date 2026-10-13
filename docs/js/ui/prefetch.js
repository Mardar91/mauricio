// Lector de fotos sin conexión: tras abrir la app con internet, descarga en segundo plano los archivos de
// Tesseract que usará este dispositivo (≈ 7 MB) para que el PRIMER escaneo también funcione sin red. Los
// guarda el service worker en su caché de vendor/ (cache-first, sw.js). No muestra nada; si falla, lo
// vuelve a intentar más tarde (y en el próximo arranque).
const BASE = 'vendor/tesseract/';
const CORES = {
  relaxed: 'core/tesseract-core-relaxedsimd-lstm.wasm.js',
  simd: 'core/tesseract-core-simd-lstm.wasm.js',
  plain: 'core/tesseract-core-lstm.wasm.js',
};
// Las mismas pruebas que hace tesseract.js (wasm-feature-detect) para elegir el núcleo (OEM 1 = LSTM)
const RELAXED_SIMD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11];
const SIMD = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];

// Núcleo que cargará tesseract.js en este dispositivo (los tres si no se puede saber)
export function coreFiles() {
  try {
    if (WebAssembly.validate(new Uint8Array(RELAXED_SIMD))) return [CORES.relaxed];
    if (WebAssembly.validate(new Uint8Array(SIMD))) return [CORES.simd];
    return [CORES.plain];
  } catch {
    return Object.values(CORES);
  }
}

// URLs completas, tal como las pide el lector (scan.js: tesseractPaths)
export function ocrFiles(base = document.baseURI) {
  return ['tesseract.min.js', 'worker.min.js', ...coreFiles(), 'lang/best_int/eng.traineddata.gz']
    .map((f) => new URL(BASE + f, base).href);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function missingFiles(files) {
  const out = [];
  for (const u of files) if (!(await caches.match(u))) out.push(u);
  return out;
}

// isBusy: () => true mientras se escanea (entonces se aplaza: el lector ya descarga lo suyo)
export function createOcrPrefetch({ isBusy = () => false } = {}) {
  const st = { status: 'idle', error: null, attempts: 0, fetched: [], aborted: 0 };
  let timer = null;
  let running = null;
  let started = false;

  const supported = () => typeof caches !== 'undefined' && Boolean(navigator.serviceWorker) && location.protocol !== 'file:';

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => { run(); }, ms);
  }

  // Reintento: a los 2 y a los 4 min (o en cuanto vuelva la conexión); después, en el próximo arranque
  // (si la caché está llena, no se descargan 7 MB una y otra vez)
  const MAX_TRIES = 3;
  function later() {
    st.attempts++;
    if (st.attempts < MAX_TRIES) schedule(2 ** st.attempts * 60000);
  }

  async function attempt() {
    if (navigator.onLine === false) { st.status = 'waiting'; return; } // 'online' lo relanza
    if (document.hidden || isBusy()) { st.status = 'waiting'; schedule(60000); return; }
    // Sin service worker que controle la página no se guardaría nada: se espera a que lo haga
    if (!navigator.serviceWorker.controller) { st.status = 'waiting'; return; } // 'controllerchange' lo relanza
    const files = ocrFiles();
    let todo = await missingFiles(files);
    if (!todo.length) { st.status = 'done'; return; }
    st.status = 'running';
    for (const u of todo) {
      if (isBusy()) { st.status = 'waiting'; schedule(60000); return; }
      // Si empieza un escaneo a mitad de un archivo, se corta: el lector descarga el suyo (y no dos veces)
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const watch = ctrl ? setInterval(() => { if (isBusy()) ctrl.abort(); }, 1000) : null;
      try {
        const res = await fetch(u, { credentials: 'same-origin', signal: ctrl?.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`);
        await res.arrayBuffer(); // el service worker guarda su copia mientras se lee
      } catch (e) {
        if (ctrl?.signal.aborted) { st.status = 'waiting'; st.aborted++; schedule(60000); return; }
        throw e;
      } finally {
        clearInterval(watch);
      }
      st.fetched.push(u);
    }
    // cache.put del service worker termina un poco después de la descarga
    for (let i = 0; i < 20; i++) {
      todo = await missingFiles(files);
      if (!todo.length) break;
      await wait(250);
    }
    if (todo.length) throw new Error(`no quedó en la caché: ${todo.join(', ')}`);
    st.status = 'done';
    st.error = null;
  }

  function run() {
    if (!running) {
      running = attempt().catch((e) => {
        st.status = 'failed';
        st.error = String(e?.message || e);
        console.warn('[lector] no se pudo descargar para usarlo sin conexión; se reintentará', st.error);
        later();
      }).finally(() => { running = null; });
    }
    return running.then(() => ({ ...st }));
  }

  // delay: espera tras arrancar (que la app abra primero, sin competir con ella)
  function start({ delay = 8000 } = {}) {
    if (started || !supported()) return;
    if (navigator.connection?.saveData) { st.status = 'off'; return; } // ahorro de datos activado
    started = true;
    const go = () => { if (st.status !== 'done' && st.attempts < MAX_TRIES) schedule(1500); };
    window.addEventListener('online', go);
    navigator.serviceWorker.addEventListener('controllerchange', go);
    setTimeout(() => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(), { timeout: 5000 });
      else run();
    }, delay);
  }

  return { start, run, status: () => ({ ...st }), files: () => ocrFiles() };
}
