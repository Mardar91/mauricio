// Reconocedor de prueba: OCR de página completa sin lógica. Sirve para validar el harness.
export async function recognize(input, options = {}) {
  const T = globalThis.Tesseract;
  const worker = await T.createWorker('eng', 1, { workerPath: options.tesseract.workerPath, corePath: options.tesseract.corePath, langPath: options.tesseract.langPath });
  const bmp = await createImageBitmap(input);
  const c = new OffscreenCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const { data } = await worker.recognize(blob);
  await worker.terminate();
  return { layout: 'unknown', month: null, year: null, days: [], warnings: [data.text.slice(0, 200)] };
}
