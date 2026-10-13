// OCR con Tesseract: pool compartido (../ocr-pool.js); aquí los trabajos van de uno en uno.
import { ready, prewarm as poolPrewarm, recognizeImage, disposePool } from '../ocr-pool.js';

export async function getWorker(tess) { return ready(tess); }

export async function disposeOcr() { await disposePool(); }

// Arranca el worker en segundo plano (sin esperar)
export function prewarm(tess) { poolPrewarm(tess); }

// Cola: Tesseract procesa un trabajo a la vez por worker
let chain = Promise.resolve();

// Reconoce un lienzo. Devuelve { text, conf, words:[{text, conf, x0,y0,x1,y1, syms}] }
export function ocr(tess, canvas, { psm = 7, whitelist = '', dpi = '300' } = {}) {
  const job = chain.then(async () => {
    const data = await recognizeImage(tess, canvas, { psm, whitelist, dpi }, { text: true, blocks: true });
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
