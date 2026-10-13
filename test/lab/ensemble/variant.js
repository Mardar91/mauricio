// Variantes del reconocedor de docs/ para medir en el laboratorio (no se usa en la app).
// Uso: node test/lab/eval.mjs --impl test/lab/ensemble/variant.js?b=always&w=2   (ver NOTES.md)
import { recognize as base, dispose } from '../../../docs/js/recognize/index.js';

const q = new URL(import.meta.url).searchParams;
const extra = {};
if (q.get('b')) extra.phoneB = q.get('b');          // auto | always | never
if (q.get('w')) extra.ocrWorkers = Number(q.get('w')); // nº de workers de Tesseract

export { dispose };
export const recognize = (input, options = {}) => base(input, { ...options, ...extra });
