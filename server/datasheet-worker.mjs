import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = path
  .dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  .replaceAll('\\', '/');
let loading;
try {
  loading = getDocument({
    data: workerData.bytes,
    isEvalSupported: false,
    useSystemFonts: false,
    ...(workerData.includeText ? {} : { canvasMaxAreaInBytes: 128 * 1024 * 1024 }),
    cMapUrl: `${root}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${root}/standard_fonts/`,
    wasmUrl: `${root}/wasm/`,
  });
  const document = await loading.promise;
  if (workerData.pageCount !== undefined && document.numPages !== workerData.pageCount)
    throw new Error('PDF page count differs from the reviewed document.');
  if (workerData.page > document.numPages || (!workerData.includeText && document.numPages > 10_000))
    throw new Error('The PDF page is outside the preview bounds.');
  async function readPage(pageNumber) {
    const page = await document.getPage(pageNumber);
    const result = { page: pageNumber, pageCount: document.numPages };
    if (workerData.includeText) {
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('');
      if (text.length > 256000) throw new Error('PDF page text exceeds the reader budget.');
      result.text = text;
    }
    if (workerData.image) {
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 2400 / Math.max(original.width, original.height));
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid PDF page dimensions.');
      const viewport = page.getViewport({ scale });
      const canvas = document.canvasFactory.create(
        Math.min(2400, Math.ceil(viewport.width)),
        Math.min(2400, Math.ceil(viewport.height)),
      );
      try {
        await page.render({ canvasContext: canvas.context, viewport }).promise;
        const png = canvas.canvas.toBuffer('image/png');
        if (png.length > 8 * 1024 * 1024)
          throw new Error('PDF page image exceeds the reader budget.');
        result.image = {
          mimeType: 'image/png',
          data: png.toString('base64'),
          width: canvas.canvas.width,
          height: canvas.canvas.height,
        };
      } finally {
        document.canvasFactory.destroy(canvas);
      }
    }
    page.cleanup();
    return result;
  }
  parentPort.postMessage(await readPage(workerData.page));
} catch (error) {
  parentPort.postMessage({ error: String(error.message).slice(0, 1000) });
} finally {
  await loading?.destroy();
}
