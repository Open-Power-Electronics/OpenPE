import { controllerModelSources } from '../../../server/reference-model-format.mjs';
import { CatalogHttpError, readCatalogBytes } from '../../../server/online-library-fetch.mjs';

const productOrigin = 'https://www.ti.com';
const pinnedArchives = new Map(controllerModelSources.map(({ archive, id }) => [archive, id]));
// These official archives have PSpice encryption markers even though TI omits
// the encryption label on their product pages.
const knownEncryptedArchives = new Set([
  'SNVM102',
  'SNVM209',
  'SNVM215',
  'SNVM216',
  'SNVM228',
  'SNVM540',
  'SNVMA66',
  'SNVMAE1',
]);
const supportedEntities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

export function tiProductNumber(input) {
  if (typeof input !== 'string') return null;
  const part = input.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{1,39}$/.test(part) ? part : null;
}

export async function searchTiModels(part, fetcher, signal) {
  const url = `${productOrigin}/product/${part}?locale=en-US`;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  let bytes;
  try {
    bytes = await readCatalogBytes(
      'TI product catalog',
      fetcher,
      url,
      { cache: 'no-store', headers: { Accept: 'text/html' } },
      2 * 1024 * 1024,
      deadline,
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CatalogHttpError) {
      if (error.status === 404) return { partNumber: part, models: [] };
      throw error;
    }
    if (deadline.aborted) throw new Error('TI model search timed out. Try again.');
    if (error instanceof TypeError)
      throw new Error('Could not reach TI. Check your internet connection and try again.');
    throw error;
  }
  const page = bytes.toString('utf8');
  if (!/<meta\s+name="idio:page-subtype"\s+content="product"\s*\/?>/i.test(page))
    throw new Error('TI did not return a product page. Try again.');

  const models = new Map();
  // TI shows the revisioned ZIP filename beside an often revisionless link.
  const cards =
    /Simulation model\s*<\/div>\s*<h4\b[^>]*>\s*<a\b([^>]{1,2048})>\s*([^<]{1,300})<\/a>\s*<\/h4>\s*<div\b[^>]*>\s*([a-z0-9]{6,16})\.zip\s*\([^<)]{1,32}\)\s*-\s*P?Spice model\s*<\/div>/gi;
  for (const [, attributes, heading, filename] of page.matchAll(cards)) {
    const link = /(?:^|\s)href="(?:https:\/\/www\.ti\.com)?\/lit\/zip\/([a-z0-9]{6,16})"/i.exec(
      attributes,
    );
    if (!link) continue;
    const archive = filename.toUpperCase();
    const downloadId = link[1].toUpperCase();
    if (
      archive !== downloadId &&
      !(archive.startsWith(downloadId) && /^[A-Z]$/.test(archive.slice(downloadId.length)))
    )
      continue;
    const title = heading
      .replace(/&([a-z]+);/gi, (entity, name) =>
        Object.hasOwn(supportedEntities, name) ? supportedEntities[name] : entity,
      )
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || models.has(archive)) continue;
    const modelId = pinnedArchives.get(archive.toLowerCase());
    const encryption =
      modelId || /\b(?:unencrypted|non[- ]encrypted|not encrypted)\b/i.test(title)
        ? 'unencrypted'
        : knownEncryptedArchives.has(archive) || /\bencrypted\b/i.test(title)
          ? 'encrypted'
          : 'unknown';
    models.set(archive, { archive, title, encryption, ...(modelId ? { modelId } : {}) });
    if (models.size === 48) break;
  }
  return { partNumber: part, models: [...models.values()] };
}
