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
    cMapUrl: `${root}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${root}/standard_fonts/`,
    wasmUrl: `${root}/wasm/`,
  });
  const document = await loading.promise;
  if (document.numPages !== workerData.pageCount)
    throw new Error('PDF page count differs from the reviewed document.');
  async function readPage(pageNumber) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
      .join('');
    if (text.length > 256000) throw new Error('PDF page text exceeds the reader budget.');
    const result = { page: pageNumber, pageCount: document.numPages, text };
    if (workerData.image) {
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 2400 / Math.max(original.width, original.height));
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid PDF page dimensions.');
      const viewport = page.getViewport({ scale });
      const canvas = document.canvasFactory.create(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
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
