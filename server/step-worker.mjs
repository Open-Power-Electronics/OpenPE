import { parentPort, workerData } from 'node:worker_threads';
import occtImport from 'occt-import-js';
import { LibraryAssetUnavailable } from './library-asset-error.mjs';
let parser;
async function convert(bytes) {
  const occt = await (parser ??= occtImport());
  const result = occt.ReadStepFile(new Uint8Array(bytes), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.003,
    angularDeflection: 0.5,
  });
  if (!result.success || !result.meshes?.length)
    throw new LibraryAssetUnavailable('The STEP model could not be tessellated.');
  const vertices = result.meshes.reduce((n, m) => n + m.attributes.position.array.length, 0);
  if (vertices > 6_000_000)
    throw new LibraryAssetUnavailable('This model exceeds the preview complexity limit.');
  return { meshes: result.meshes, heapBytes: occt.HEAPU8.buffer.byteLength };
}

if (workerData) {
  // Existing isolated placement checks use a one-shot worker directly.
  try {
    const { meshes } = await convert(workerData);
    parentPort.postMessage({ meshes });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
} else {
  let busy = false;
  parentPort.on('message', async ({ requestId, bytes }) => {
    if (busy) {
      parentPort.postMessage({
        requestId,
        error: 'The STEP parser is already converting a model.',
      });
      return;
    }
    busy = true;
    try {
      parentPort.postMessage({ requestId, ...(await convert(bytes)) });
    } catch (error) {
      parentPort.postMessage({
        requestId,
        error: error.message,
        unavailable: error instanceof LibraryAssetUnavailable,
      });
    } finally {
      busy = false;
    }
  });
}
