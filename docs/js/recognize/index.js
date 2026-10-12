// Reconocimiento de fotos del plan de turnos.
// STUB provisional: será reemplazado por el reconocedor elegido en test/lab/approaches/.
// Contrato: ver SPEC.md §5.

export async function recognize(input, options = {}) {
  options.onProgress?.(1, 'Listo');
  return { layout: 'unknown', month: null, year: null, days: [], warnings: ['No se pudo leer la foto automáticamente.'] };
}

export async function dispose() {}
