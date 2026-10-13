// OCR con el pool compartido (../ocr-pool.js): los trabajos se reparten entre sus workers.
import { ready, recognizeImage, disposePool } from '../ocr-pool.js';

let paths = null;

export async function ensureWorkers(p = {}, n = 2) {
  paths = p;
  await ready(p);
}

export async function disposeWorkers() { await disposePool(); }

// OCR de un lienzo. Devuelve { text, conf, words: [{text, conf, bbox, symbols: [{text, conf, bbox}]}] }
export function ocr(image, { psm = 7, whitelist = '' } = {}) {
  return recognizeImage(paths, image, { psm, whitelist }, { blocks: true, text: true }).then(parse);
}

function parse(data) {
  const words = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
    words.push({ text: wd.text, conf: wd.confidence, bbox: wd.bbox, symbols: (wd.symbols || []).map((s) => ({ text: s.text, conf: s.confidence, bbox: s.bbox })) });
  }
  return { text: (data.text || '').trim(), conf: data.confidence ?? 0, words };
}
