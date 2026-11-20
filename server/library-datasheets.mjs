import express from 'express';
import { renderDatasheetPage } from './datasheets.mjs';
import { libraryAssetFailure } from './library-asset-error.mjs';
import { isLibraryDatasheetSource } from './library-format.mjs';
import { readCatalogBytes } from './online-library-fetch.mjs';

const maximumPdfBytes = 32 * 1024 * 1024;
const manufacturerPaths = new Map([
  ['www.ti.com', /^\/lit\//],
  [
    'www.st.com',
    /^\/(?:resource\/en\/datasheet|content\/ccc\/resource\/technical\/document|internet\/com\/TECHNICAL_RESOURCES)\//,
  ],
  ['ww1.microchip.com', /^\/downloads\//],
  ['www.analog.com', /^\/(?:media|static)\//],
  ['www.onsemi.com', /^\/(?:pub|pub_link|pdf|download)\//],
  ['www.nxp.com', /^\/docs\//],
  ['www.vishay.com', /^\/docs\//],
  ['www.infineon.com', /^\/dgdl\//],
  ['assets.nexperia.com', /^\/documents\//],
  ['www.diodes.com', /^\/(?:assets|_files)\//],
  ['datasheets.maximintegrated.com', /^\/en\/ds\//],
]);
const nextPcbHosts = new Set(['file.elecfans.com', 'file1.elecfans.com', 'file.eda.cn']);

function catalogPdfUrl({ value, code }, source) {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^https?:\/\//i.test(value) ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    return null;
  const url = URL.parse(value);
  if (!url || url.port || url.username || url.password || !/\.pdf$/i.test(url.pathname))
    return null;
  url.hash = '';
  if (source === 'jlcpcb') {
    const file = /^\/smtDataManualFile\/\d+-(C[1-9]\d{0,11})\.pdf$/.exec(url.pathname);
    return url.protocol === 'https:' &&
      url.hostname === 'jlc-prod-smt.oss-eu-central-1.aliyuncs.com' &&
      file &&
      file[1] === code
      ? url.href
      : null;
  }
  if (
    !manufacturerPaths.get(url.hostname)?.test(url.pathname) &&
    !(nextPcbHosts.has(url.hostname) && /^\/web[12]\/M00\//.test(url.pathname))
  )
    return null;
  url.protocol = 'https:';
  url.search = '';
  return url.href;
}

function isPreviewRequest(input) {
  return (
    input &&
    typeof input === 'object' &&
    Object.keys(input).length === 4 &&
    typeof input.id === 'string' &&
    input.id.length <= 500 &&
    /^[^:\u0000-\u001f\u007f]+:[^\u0000-\u001f\u007f]+$/.test(input.id) &&
    ['symbols', 'footprints'].includes(input.kind) &&
    isLibraryDatasheetSource(input.source) &&
    Number.isInteger(input.page) &&
    input.page >= 1 &&
    input.page <= 10_000
  );
}

/** Preview data is private to this service and scoped to the resolved catalog ID. */
export function createLibraryDatasheetReader({ reference, fetcher, shutdown }) {
  const cache = new Map();
  shutdown.addEventListener('abort', () => cache.clear(), { once: true });
  let active = 0;
  return async (input, requestSignal) => {
    const signal = AbortSignal.any([shutdown, requestSignal, AbortSignal.timeout(45_000)]);
    signal.throwIfAborted();
    if (active >= 2) throw new Error('Datasheet previews are busy. Try again shortly.');
    const { id, kind, source, page } = input;
    const key = JSON.stringify([kind, id, source]);
    active++;
    try {
      const saved = cache.get(key);
      let bytes = saved?.expires > Date.now() ? saved.bytes : undefined;
      if (bytes) {
        cache.delete(key);
        cache.set(key, saved);
      } else {
        cache.delete(key);
        const match = await reference(input, signal);
        signal.throwIfAborted();
        const url = match && catalogPdfUrl(match, source);
        if (!url) return null;
        bytes = await readCatalogBytes(
          'Datasheet',
          fetcher,
          url,
          { headers: { Accept: 'application/pdf' }, cache: 'no-store' },
          maximumPdfBytes,
          signal,
        );
        if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-')
          throw new Error('The catalog did not return a PDF.');
      }
      const result = await renderDatasheetPage(bytes, page, true, undefined, signal, {
        includeText: false,
      });
      signal.throwIfAborted();
      if (!saved || saved.bytes !== bytes) {
        cache.set(key, { bytes, expires: Date.now() + 5 * 60_000 });
        while (cache.size > 2) cache.delete(cache.keys().next().value);
      }
      return result;
    } catch {
      throw new Error('Could not load the datasheet. Try again.');
    } finally {
      active--;
    }
  };
}

export function registerLibraryDatasheetPreview(app, route, libraries) {
  app.post(route, express.json({ limit: '2kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isPreviewRequest(req.body))
      return res
        .status(400)
        .json({ error: 'Send a component ID, library kind, PDF source and page.' });
    const control = new AbortController();
    res.once('close', () => control.abort());
    try {
      const preview = await libraries.datasheet(req.body, control.signal);
      if (!res.destroyed) res.json(preview);
    } catch (error) {
      if (!res.destroyed) res.status(422).json(libraryAssetFailure(error));
    }
  });
}
