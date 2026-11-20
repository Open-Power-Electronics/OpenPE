import {
  parseLibrary,
  resolveSymbol,
  symbolUnits,
  parseSExpr,
  propertyValue,
  children,
  child,
  num,
  val,
  quote,
  createProject,
  createLibraryPart,
  libraryPackageCodeKind,
  libraryPackageQuery,
  matchesLibraryPackage,
  validateProject,
} from './library-format.mjs';
import { createEmptyPCB, createPCBFootprint, readLibraryFootprint } from './pcb-layout-format.mjs';
import { officialModelRelativePath } from './library-model-reference.mjs';
import { CatalogHttpError, readCatalogBytes } from './online-library-fetch.mjs';
import { LibraryAssetUnavailable } from './library-asset-error.mjs';
import { readNextpcbSupplyPrices } from './nextpcb-prices.mjs';
import { matchesPricePart } from './library-prices.mjs';

const ORIGIN = 'https://library.nextpcb.com';
// The provider's 100-row option currently returns a false empty page.
// Use its verified 50-row page size and map offsets to those native pages.
const PAGE_SIZE = 50;
const SUGGESTED_CATEGORY = '1737';
const PACKAGE_SEARCH_CATEGORIES = {
  // Chip Resistors, Chip Capacitor (MLCC), Ceramic Capacitors, Inductors and Chip Bead.
  chip: ['1009', '398', '1173', '856', '364'],
  // General Purpose Transistors, MOSFETs, Schottky Diode, Amplifiers and Linear Regulators.
  named: ['1575', '1578', '1558', '1737', '1700'],
};
const MAX_NATIVE_BYTES = 2_000_000;
const MAX_JSON_BYTES = 2_000_000;
const MAX_MODEL_BYTES = 32 * 1024 * 1024;
const CACHE_LIFETIME = 5 * 60_000;

function text(value, maximum = 4096) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value))
    throw new Error('NextPCB returned invalid component metadata.');
  return value;
}

function description(value) {
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('NextPCB returned invalid component metadata.');
  return text(value.replace(/[\t\r\n]+/g, ' '));
}

function identity(manufacturer, mpn) {
  const number = String(manufacturer);
  if (!/^[1-9]\d{0,18}$/.test(number) || !text(mpn, 200))
    throw new Error('NextPCB returned an invalid component identity.');
  const id = `NextPCB:${number}_${encodeURIComponent(mpn)}`;
  if (id.length > 500) throw new Error('NextPCB component identity exceeds its supported limit.');
  return id;
}

function decodeIdentity(id) {
  if (typeof id !== 'string' || id.length > 500)
    throw new Error('Invalid NextPCB component identity.');
  const match = /^NextPCB:([1-9]\d{0,18})_(.+)$/.exec(id);
  if (!match) throw new Error('Invalid NextPCB component identity.');
  let mpn;
  try {
    mpn = decodeURIComponent(match[2]);
    if (identity(match[1], mpn) !== id) throw new Error();
  } catch {
    throw new Error('Invalid NextPCB component identity.');
  }
  return { manufacturer_id: match[1], mpn };
}

function assetUrl(value, extension) {
  if (typeof value !== 'string' || value.length > 2048)
    throw new LibraryAssetUnavailable('NextPCB returned an invalid native asset URL.');
  const source = value.startsWith('//') ? `https:${value}` : value;
  const basename = /^https:\/\/file\.eda\.cn\/web[12]\/M00\/(?:[A-Za-z0-9_-]+\/)*([^/\\?#]+)$/.exec(
    source,
  )?.[1];
  let filename = '';
  try {
    if (basename) filename = decodeURIComponent(basename);
  } catch {
    throw new LibraryAssetUnavailable('NextPCB returned an invalid native asset URL.');
  }
  if (
    /[\u0000-\u001f\u007f]/.test(filename) ||
    !new RegExp(`^[\\p{L}\\p{N}_-][\\p{L}\\p{N} _().+-]*\\.${extension}$`, 'u').test(filename)
  )
    throw new LibraryAssetUnavailable(
      'NextPCB native asset is outside its supported HTTPS source.',
    );
  return new URL(source).href;
}

function footprintWarning(message) {
  const reason = String(message)
    .replace(/[\u0000-\u001f]/g, ' ')
    .slice(0, 300);
  return `Footprint unavailable: ${reason} Choose a supported footprint in Properties.`;
}

function put(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, { time: Date.now(), value: structuredClone(value) });
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function cached(cache, key) {
  const entry = cache.get(key);
  if (!entry) return;
  if (Date.now() - entry.time > CACHE_LIFETIME) {
    cache.delete(key);
    return;
  }
  return structuredClone(entry.value);
}

function setProperty(symbol, name, value) {
  const existing = children(symbol, 'property').find((node) => val(node) === name);
  if (existing) existing[2] = quote(value);
  else
    symbol.push([
      'property',
      quote(name),
      quote(value),
      ['at', '0', '0', '0'],
      ['effects', ['font', ['size', '1.27', '1.27']], ['hide', 'yes']],
    ]);
}

function readPackage(entry, source) {
  const footprint = parseSExpr(source, MAX_NATIVE_BYTES);
  const version = child(footprint, 'version');
  if (footprint[0] !== 'footprint' || num(version) > 20260206)
    throw new Error('Unsupported NextPCB footprint version.');
  const models = children(footprint, 'model').map((model) => {
    const path = val(model);
    try {
      officialModelRelativePath(path);
    } catch {
      throw new Error('NextPCB model references must use the supported KiCad 3D library.');
    }
    const inchOffsets = children(model, 'at');
    if (inchOffsets.length) {
      const [at] = inchOffsets;
      const xyz = child(at, 'xyz');
      if (
        val(version) !== '20210108' ||
        inchOffsets.length !== 1 ||
        child(model, 'offset') ||
        at.length !== 2 ||
        xyz?.length !== 4
      )
        throw new Error('Unsupported NextPCB 3D model offset.');
      const millimetres = xyz.slice(1).map((coordinate) => {
        if (
          typeof coordinate !== 'string' ||
          !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(coordinate)
        )
          throw new Error('Invalid NextPCB 3D model offset.');
        const mm = Number(coordinate) * 25.4;
        const native = Number(mm.toFixed(6));
        if (!Number.isFinite(mm) || Math.abs(mm) > 100000 || Math.abs(mm - native) > 1e-9)
          throw new Error('NextPCB 3D model offset exceeds native coordinate bounds or precision.');
        return String(native);
      });
      model[model.indexOf(at)] = ['offset', ['xyz', ...millimetres]];
    }
    const offset = child(model, 'offset'),
      scale = child(model, 'scale'),
      rotate = child(model, 'rotate');
    return {
      path,
      ...(offset ? { offset } : {}),
      ...(scale ? { scale } : {}),
      ...(rotate ? { rotate } : {}),
    };
  });
  footprint[1] = quote(entry.id.slice('NextPCB:'.length));
  return {
    ...entry,
    footprint,
    pads: [
      ...new Set(
        children(footprint, 'pad')
          .map((pad) => val(pad))
          .filter(Boolean),
      ),
    ],
    models,
  };
}

/** Read-only public NextPCB catalog; all returned documents still require Core admission. */
export function createNextPcbLibrary({ fetcher = fetch } = {}) {
  const shutdown = new AbortController();
  const pages = new Map();
  const metadata = new Map();
  const details = new Map();
  const categoryCache = new Map();
  let active = 0;

  async function read(url, options, maximum, signal) {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      await readCatalogBytes('NextPCB', fetcher, url, options, maximum, signal),
    );
  }

  async function api(path, body, signal) {
    const source = await read(
      ORIGIN + path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      },
      MAX_JSON_BYTES,
      signal,
    );
    let result;
    try {
      result = JSON.parse(source);
    } catch {
      throw new Error('NextPCB returned invalid catalog JSON.');
    }
    if (!Number.isSafeInteger(result?.code))
      throw new Error('NextPCB returned an invalid catalog response.');
    if (result.code !== 200000)
      throw new Error(`NextPCB rejected the catalog request (code ${result.code}).`);
    if (!Object.hasOwn(result, 'result'))
      throw new Error('NextPCB returned an invalid catalog response.');
    return result;
  }

  async function componentRecord(id, signal) {
    const key = decodeIdentity(id);
    const { result } = await api('/api/chiplet/kicad/productDetail', key, signal);
    if (!result || identity(result.mfgId, result.mpn) !== id)
      throw new Error('NextPCB returned a different or invalid component.');
    return result;
  }

  async function pricingPart(id, signal) {
    const key = decodeIdentity(id);
    const { entry } = cached(metadata, id) ?? {};
    const manufacturer = entry
      ? entry.manufacturer
      : text((await componentRecord(id, signal)).mfg ?? '', 200);
    return { ...key, manufacturer };
  }

  async function product(id, signal) {
    const saved = cached(metadata, id);
    if (saved) return saved;
    const result = await componentRecord(id, signal);
    if (!Array.isArray(result.cadUrlList))
      throw new Error('NextPCB returned a different or invalid component.');
    if (result.cadUrlList.length > 32) throw new Error('NextPCB returned too many native assets.');
    const urls = {};
    const assetErrors = {};
    for (const [type, extension] of [
      ['symbol', 'kicad_sym'],
      ['footprint', 'kicad_mod'],
    ]) {
      const assets = result.cadUrlList.filter((entry) => entry?.type === type);
      if (assets.length > 1) {
        assetErrors[type] = `NextPCB returned ambiguous ${type} assets.`;
        continue;
      }
      if (!assets.length) continue;
      try {
        urls[type] = assetUrl(assets[0].fileUrl, extension);
      } catch (error) {
        if (!(error instanceof LibraryAssetUnavailable)) throw error;
        assetErrors[type] = error.message;
      }
    }
    const entry = {
      id,
      name: text(result.mpn, 200),
      library: 'NextPCB',
      description: description(result.description ?? ''),
      keywords: [text(result.mfg ?? '', 200), text(result.mfPackageCode ?? '', 200)].join(' '),
      ...(result.mfg != null ? { manufacturer: text(result.mfg, 200) } : {}),
      ...(result.mfPackageCode != null ? { package: text(result.mfPackageCode, 200) } : {}),
      ...(urls.footprint || assetErrors.footprint ? { footprint: id } : {}),
    };
    const value = { entry, urls, assetErrors };
    const modelAssets = result.cadUrlList.filter((asset) => asset?.type === '3d');
    value.modelAssets = modelAssets.map((asset) => ({ fileUrl: asset.fileUrl }));
    if (!Object.keys(assetErrors).length) put(metadata, id, value, 32);
    return structuredClone(value);
  }

  async function categories(signal) {
    const saved = cached(categoryCache, 'tree');
    if (saved) return saved;
    const { result } = await api('/api/chiplet/products/cateTree', {}, signal);
    if (!Array.isArray(result) || result.length > 2000)
      throw new Error('NextPCB returned an invalid category catalog.');
    const records = new Map();
    for (const row of result) {
      if (
        !row ||
        !Number.isSafeInteger(row.cateId) ||
        row.cateId <= 0 ||
        row.cateId > 9999999999 ||
        !Number.isSafeInteger(row.parentId) ||
        row.parentId < 0 ||
        row.parentId > 9999999999 ||
        !Number.isInteger(row.level) ||
        row.level < 1 ||
        row.level > 8 ||
        records.has(row.cateId)
      )
        throw new Error('NextPCB returned invalid or duplicate category identities.');
      const name = text(row.cateDisplayName, 200).trim();
      if (!name) throw new Error('NextPCB returned an unnamed category.');
      records.set(row.cateId, {
        parent: row.parentId,
        level: row.level,
        node: { id: String(row.cateId), name, children: [] },
      });
    }
    const roots = [];
    for (const [id, record] of records) {
      const seen = new Set([id]);
      let ancestor = record;
      while (ancestor.parent !== 0 && records.has(ancestor.parent)) {
        if (seen.has(ancestor.parent)) throw new Error('NextPCB returned cyclic categories.');
        seen.add(ancestor.parent);
        if (seen.size > 8) throw new Error('NextPCB category nesting exceeds its supported limit.');
        const parent = records.get(ancestor.parent);
        if (parent.level !== ancestor.level - 1)
          throw new Error('NextPCB returned inconsistent category levels.');
        ancestor = parent;
      }
      if (ancestor.parent === 0 && ancestor.level !== 1)
        throw new Error('NextPCB returned an invalid category root.');
      if (record.parent === 0) roots.push(record.node);
      else records.get(record.parent)?.node.children.push(record.node);
    }
    const ids = [];
    function order(nodes) {
      nodes.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
      for (const node of nodes) {
        ids.push(node.id);
        order(node.children);
      }
    }
    // Match the provider's tree: records whose parent is absent are not roots.
    // Never invent missing categories or promote disconnected branches.
    order(roots);
    const value = { categories: roots, ids };
    signal.throwIfAborted();
    put(categoryCache, 'tree', value, 1);
    return structuredClone(value);
  }

  async function searchPage(keyword, catalogCategory, pageNum, signal) {
    const key = JSON.stringify([keyword, catalogCategory, pageNum]);
    let page = cached(pages, key);
    if (!page) {
      const result = await api(
        '/api/chiplet/products/kicad/queryPage',
        {
          pageNum,
          pageSize: PAGE_SIZE,
          haveEdaModel: 1,
          have3dModel: 0,
          haveSimModel: 0,
          haveSupplierModel: 0,
          ...(keyword ? { desc: keyword } : {}),
          ...(catalogCategory ? { cateId: Number(catalogCategory) } : {}),
        },
        signal,
      );
      if (
        !Array.isArray(result.result) ||
        result.result.length > PAGE_SIZE ||
        !Number.isSafeInteger(result.total) ||
        result.total < 0
      )
        throw new Error('NextPCB returned an invalid search page.');
      page = {
        total: result.total,
        entries: result.result.map((row) => {
          let hasFootprint = false;
          try {
            assetUrl(row?.footprintFileUrl, 'kicad_mod');
            hasFootprint = true;
          } catch (error) {
            if (!(error instanceof LibraryAssetUnavailable)) throw error;
          }
          const id = identity(row.manufacturer_id, row.mpn);
          return {
            id,
            name: text(row.mpn, 200),
            library: 'NextPCB',
            description: description(row.Description ?? ''),
            keywords: [
              text(row.manufacturer ?? '', 200),
              text(row.category ?? '', 200),
              text(row.package ?? '', 200),
            ].join(' '),
            ...(row.manufacturer != null ? { manufacturer: text(row.manufacturer, 200) } : {}),
            ...(row.package != null ? { package: text(row.package, 200) } : {}),
            ...(hasFootprint ? { footprint: id } : {}),
          };
        }),
      };
      const ids = page.entries.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length)
        throw new Error('NextPCB returned duplicate component identities.');
      put(pages, key, page, 8);
    }
    return page;
  }

  async function searchPackageSample({ kind, query, packageKind, offset, scanLimit }, signal) {
    const { ids } = await categories(signal);
    const scope = PACKAGE_SEARCH_CATEGORIES[packageKind].filter((id) => ids.includes(id));
    const pages = scope.map((id) => searchPage('', id, 1, signal));
    if (packageKind === 'named') pages.push(searchPage(query, '', 1, signal));
    if (!pages.length) throw new Error('NextPCB chip package categories are unavailable.');
    const matches = new Map();
    for (const { entries } of await Promise.all(pages))
      for (const entry of entries)
        if (
          (kind === 'symbols' || entry.footprint) &&
          matchesLibraryPackage(entry.package, query) &&
          !matches.has(entry.id)
        )
          matches.set(entry.id, entry);
    const end = offset + scanLimit;
    return {
      entries: [...matches.values()].slice(offset, end),
      total: matches.size,
      nextOffset: end < matches.size ? end : null,
      libraries: ['NextPCB'],
    };
  }

  async function search(
    { kind, query = '', library = 'NextPCB', category = '', offset = 0, scanLimit = PAGE_SIZE },
    signal,
    allowPackageQuery = true,
  ) {
    if (
      library !== 'NextPCB' ||
      typeof query !== 'string' ||
      query.length > 200 ||
      /[\u0000-\u001f]/.test(query) ||
      typeof category !== 'string' ||
      (category !== '' && !/^[1-9]\d{0,9}$/.test(category)) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 999999
    )
      throw new Error('Invalid NextPCB search.');
    const packageQuery = allowPackageQuery ? libraryPackageQuery(query) : undefined;
    const packageKind = packageQuery && libraryPackageCodeKind(packageQuery);
    if (packageKind && !category)
      return searchPackageSample({ kind, query: packageQuery, packageKind, offset, scanLimit }, signal);
    if (packageQuery === '')
      return { entries: [], total: 0, nextOffset: null, libraries: ['NextPCB'] };
    // With a category, browse its package metadata independently of the provider's text index.
    const keyword = packageQuery === undefined ? query.trim() : category ? '' : packageQuery;
    const catalogCategory = category || (keyword ? '' : SUGGESTED_CATEGORY);
    if (catalogCategory && !(await categories(signal)).ids.includes(catalogCategory))
      throw new Error(
        category
          ? 'Choose an available NextPCB category.'
          : 'NextPCB suggestions are unavailable. Enter a model or choose a category.',
      );
    const page = await searchPage(
      keyword,
      catalogCategory,
      Math.floor(offset / PAGE_SIZE) + 1,
      signal,
    );
    const start = offset % PAGE_SIZE;
    const end = packageQuery === undefined ? Math.min(PAGE_SIZE, start + scanLimit) : PAGE_SIZE;
    const entries = [];
    let cursor = start;
    while (cursor < end && entries.length < scanLimit) {
      const entry = page.entries[cursor++];
      if (
        entry &&
        (kind === 'symbols' || entry.footprint) &&
        (packageQuery === undefined || matchesLibraryPackage(entry.package, packageQuery))
      )
        entries.push(entry);
    }
    const next = offset - start + cursor;
    return {
      entries,
      total: page.total,
      nextOffset: next < Math.min(page.total, 1_000_000) ? next : null,
      libraries: ['NextPCB'],
    };
  }

  async function detail({ kind, id }, signal) {
    decodeIdentity(id);
    const key = `${kind}:${id}`;
    const saved = cached(details, key);
    if (saved) return saved;
    const { entry, urls, assetErrors } = await product(id, signal);
    if (kind === 'footprints') {
      if (assetErrors.footprint || !urls.footprint)
        throw new LibraryAssetUnavailable(
          assetErrors.footprint ?? 'This NextPCB component has no native KiCad footprint.',
        );
      const source = await read(urls.footprint, {}, MAX_NATIVE_BYTES, signal).catch((error) => {
        if (error instanceof CatalogHttpError && error.status === 404)
          throw new LibraryAssetUnavailable(error.message);
        throw error;
      });
      let packageDetail;
      try {
        packageDetail = readPackage(entry, source);
        const project = createProject();
        project.pcb = createEmptyPCB();
        project.pcb.footprints = [
          {
            id: crypto.randomUUID(),
            libraryId: id,
            symbolId: null,
            reference: 'U1',
            value: entry.name,
            side: 'front',
            x: 0,
            y: 0,
            rotation: 0,
            ...readLibraryFootprint(packageDetail),
          },
        ];
        validateProject(project);
      } catch (error) {
        throw new LibraryAssetUnavailable(error.message);
      }
      signal.throwIfAborted();
      put(details, key, packageDetail, 16);
      return packageDetail;
    }
    if (!urls.symbol)
      throw new Error(assetErrors.symbol ?? 'This NextPCB component has no native KiCad symbol.');
    const [symbolRead, footprintRead] = await Promise.allSettled([
      read(urls.symbol, {}, MAX_NATIVE_BYTES, signal),
      urls.footprint
        ? read(urls.footprint, {}, MAX_NATIVE_BYTES, signal)
        : Promise.resolve(undefined),
    ]);
    if (symbolRead.status === 'rejected') throw symbolRead.reason;
    const symbols = parseLibrary(symbolRead.value);
    if (symbols.length !== 1)
      throw new Error('NextPCB symbol libraries must contain exactly one component.');
    const symbol = resolveSymbol(symbols, val(symbols[0]), 'NextPCB');
    symbol[1] = quote(id);
    for (const unit of children(symbol, 'symbol')) {
      const suffix = val(unit).match(/_\d+_\d+$/)?.[0];
      if (!suffix) throw new Error('NextPCB returned an unsupported symbol unit name.');
      unit[1] = quote(id.slice('NextPCB:'.length) + suffix);
    }
    setProperty(symbol, 'Value', entry.name);
    setProperty(symbol, 'Footprint', entry.footprint ?? '');
    const reference = propertyValue(symbol, 'Reference').replace(/\?+$/, '');
    if (!reference || !/^[A-Za-z#][A-Za-z0-9_]*$/.test(reference))
      throw new Error('NextPCB symbol has an unsupported reference prefix.');
    setProperty(symbol, 'Reference', reference);
    const project = createProject();
    project.schematic.libraries = { [id]: symbol };
    project.schematic.parts = [createLibraryPart(project.schematic, symbol, 0, 0)];
    validateProject(project);
    let packageDetail;
    let warning = assetErrors.footprint ? footprintWarning(assetErrors.footprint) : undefined;
    let footprintUnavailable = !!assetErrors.footprint;
    // Preflight the linked package with the shared converter. A valid schematic
    // symbol retains its exact assignment when bounded PCB geometry is unavailable.
    if (urls.footprint) {
      try {
        if (footprintRead.status === 'rejected') throw footprintRead.reason;
        packageDetail = readPackage(entry, footprintRead.value);
        project.pcb = createEmptyPCB();
        project.pcb.footprints = [
          createPCBFootprint(packageDetail, project.schematic, project.schematic.parts[0].id, {
            x: 0,
            y: 0,
          }),
        ];
        validateProject(project);
      } catch (error) {
        signal.throwIfAborted();
        footprintUnavailable =
          footprintRead.status === 'fulfilled' ||
          (error instanceof CatalogHttpError && error.status === 404);
        packageDetail = undefined;
        warning = footprintWarning(error.message);
      }
    }
    signal.throwIfAborted();
    const footprintPreview =
      footprintUnavailable || !urls.footprint
        ? 'unavailable'
        : packageDetail && (packageDetail.models.length ? '2d-and-3d' : '2d');
    const symbolDetail = {
      ...entry,
      symbol,
      units: symbolUnits(symbol),
      ...(warning ? { warning } : {}),
      ...(footprintPreview ? { footprintPreview } : {}),
    };
    if (!warning) put(details, `symbols:${id}`, symbolDetail, 16);
    if (packageDetail) put(details, `footprints:${id}`, packageDetail, 16);
    return symbolDetail;
  }

  async function run(signal, operation) {
    if (shutdown.signal.aborted) throw new Error('NextPCB library service closed.');
    if (active >= 8) throw new Error('Too many NextPCB requests. Try again shortly.');
    signal = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(20_000),
      ...(signal ? [signal] : []),
    ]);
    signal.throwIfAborted();
    active++;
    try {
      const result = await operation(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted)
        throw new Error('NextPCB request cancelled or timed out. Retry when online.');
      if (error instanceof TypeError)
        throw new Error('NextPCB request failed. Check your internet connection and retry.');
      throw error;
    } finally {
      active--;
    }
  }
  async function matchingParts(part, signal) {
    const { entries } = await search({ kind: 'symbols', query: part.mpn }, signal, false);
    return entries.filter(({ name, manufacturer }) => matchesPricePart(part, name, manufacturer));
  }
  return {
    async price(id, signal) {
      return run(signal, async (signal) => {
        const part = await pricingPart(id, signal);
        const [result] = await readNextpcbSupplyPrices(fetcher, [part], signal);
        if (result.error) throw new Error(result.error);
        return result.quote;
      });
    },
    pricingPart: (id, signal) => run(signal, (signal) => pricingPart(id, signal)),
    datasheetReference: (id, signal) =>
      run(signal, async (signal) => (await componentRecord(id, signal)).datasheet),
    searchDatasheet(part, signal) {
      return run(signal, async (signal) => {
        const matches = await matchingParts(part, signal);
        if (matches.length !== 1) return undefined;
        const result = await componentRecord(matches[0].id, signal);
        if (matchesPricePart(part, result.mpn, result.mfg)) return result.datasheet;
      });
    },
    searchPrices(part, signal) {
      return run(signal, async (signal) => {
        const matches = (await matchingParts(part, signal))
          .slice(0, 4)
          .map(({ id }) => decodeIdentity(id));
        if (!matches.length) return [];
        const results = await readNextpcbSupplyPrices(fetcher, matches, signal);
        const offers = new Map();
        for (const result of results) {
          for (const offer of result.quote.offers) offers.set(offer.sku, offer);
        }
        const failure = results.find((result) => result.error);
        if (!offers.size && failure) throw new Error(failure.error);
        return [...offers.values()].slice(0, 4);
      });
    },
    async request(message) {
      if (
        !['symbols', 'footprints'].includes(message.kind) ||
        !['search', 'detail', 'categories'].includes(message.action)
      )
        throw new Error('Unsupported NextPCB library operation.');
      return run(message.signal, async (signal) =>
        message.action === 'categories'
          ? { categories: (await categories(signal)).categories }
          : message.action === 'search'
            ? search(message, signal)
            : detail(message, signal),
      );
    },
    async modelBytes(id, index, signal) {
      decodeIdentity(id);
      if (!Number.isInteger(index) || index < 0 || index > 31)
        throw new Error('Invalid NextPCB model index.');
      return run(signal, async (signal) => {
        const { modelAssets } = await product(id, signal);
        if (!modelAssets.length) return undefined;
        if (modelAssets.length !== 1)
          throw new LibraryAssetUnavailable('NextPCB returned ambiguous 3D assets.');
        const url = assetUrl(modelAssets[0].fileUrl, '(?:step|stp)');
        const footprint = await detail({ kind: 'footprints', id }, signal);
        if (footprint.models.length !== 1 || index !== 0)
          throw new LibraryAssetUnavailable(
            'NextPCB STEP adoption requires exactly one native footprint model reference.',
          );
        const bytes = await readCatalogBytes('NextPCB', fetcher, url, {}, MAX_MODEL_BYTES, signal);
        if (!bytes.subarray(0, 100).toString('ascii').includes('ISO-10303-21'))
          throw new LibraryAssetUnavailable('NextPCB returned an invalid STEP model.');
        return bytes;
      });
    },
    close() {
      shutdown.abort();
      pages.clear();
      metadata.clear();
      details.clear();
      categoryCache.clear();
    },
  };
}
