import { convertJlcpcbComponent } from './jlcpcb-cad.mjs';
import { readCatalogBytes } from './online-library-fetch.mjs';

const catalogUrl =
  'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2';
const cadOrigin = 'https://easyeda.com';
const pageSize = 100;
const partCode = /^C[1-9]\d{0,11}$/;
const categoryId = /^[1-9]\d{0,9}$/;
const catalogLifetime = 5 * 60_000;
const concurrentCadReads = 8;

function remember(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, { value, expires: Date.now() + catalogLifetime });
  if (cache.size > limit) cache.delete(cache.keys().next().value);
}

function recall(cache, key) {
  const saved = cache.get(key);
  if (saved?.expires > Date.now()) return saved.value;
  cache.delete(key);
}

function catalogText(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value))
    throw new Error('JLCPCB returned invalid catalog metadata.');
  return value;
}

function entryFor(row) {
  if (typeof row?.componentCode !== 'string' || !partCode.test(row.componentCode))
    throw new Error('JLCPCB returned an invalid component identity.');
  const name = catalogText(row.componentModelEn, 200);
  if (!name.trim()) throw new Error('JLCPCB returned an unnamed component.');
  return {
    id: `JLCPCB:${row.componentCode}`,
    name,
    library: 'JLCPCB',
    description: catalogText(row.describe ?? '', 4096),
    keywords: [row.componentCode, catalogText(row.componentTypeEn ?? '', 200)].join(' '),
    ...(row.componentBrandEn != null
      ? { manufacturer: catalogText(row.componentBrandEn, 200) }
      : {}),
    ...(row.componentSpecificationEn != null
      ? { package: catalogText(row.componentSpecificationEn, 200) }
      : {}),
  };
}

function categoryTree(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2000)
    throw new Error('JLCPCB returned an invalid category catalog.');
  const filters = new Map();
  let seen = 0;

  function entry(row, parent) {
    if (
      ++seen > 2000 ||
      !Number.isSafeInteger(row?.componentSortKeyId) ||
      !categoryId.test(String(row.componentSortKeyId)) ||
      row.grade !== (parent ? 2 : 1) ||
      row.parentId !== (parent ? Number(parent.id) : 0) ||
      (row.childSortList !== null && !Array.isArray(row.childSortList)) ||
      (parent && row.childSortList?.length)
    )
      throw new Error('JLCPCB returned an invalid category hierarchy.');
    const id = String(row.componentSortKeyId);
    const name = catalogText(row.sortName, 200);
    if (!name.trim()) throw new Error('JLCPCB returned an unnamed category.');
    const filter = parent
      ? { firstSortName: parent.name, secondSortName: name }
      : { firstSortName: name };
    const previous = filters.get(id);
    if (previous) {
      // The provider catalog can repeat a leaf in the same parent.
      if (parent && previous.parentId === parent.id && previous.filter.secondSortName === name)
        return null;
      throw new Error('JLCPCB returned a conflicting category identity.');
    }
    filters.set(id, { parentId: parent?.id, filter });
    const node = { id, name, children: [] };
    for (const child of row.childSortList ?? []) {
      const category = entry(child, node);
      if (category) node.children.push(category);
    }
    return node;
  }

  return { categories: rows.map((row) => entry(row)), filters };
}

export function createJlcpcbLibrary({ fetcher = fetch } = {}) {
  const shutdown = new AbortController();
  const pages = new Map();
  const availability = new Map();
  const details = new Map();
  const cadReads = new Set();
  let categories;
  let active = 0;

  async function readJson(provider, url, options, signal) {
    const bytes = await readCatalogBytes(provider, fetcher, url, options, 2_000_000, signal);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error(`${provider} returned invalid JSON.`);
    }
  }

  function catalogRequest(body, signal) {
    return readJson(
      'JLCPCB',
      catalogUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
    );
  }

  async function loadCategories(signal) {
    if (categories?.expires > Date.now()) return categories;
    const response = await catalogRequest({ searchType: 1, pageSize: 0 }, signal);
    if (response?.code !== 200) throw new Error('JLCPCB rejected the category request.');
    const catalog = categoryTree(response.data?.sortAndCountVoList);
    signal.throwIfAborted();
    categories = { ...catalog, expires: Date.now() + catalogLifetime };
    return categories;
  }

  async function loadPage(keyword, currentPage, filter, signal) {
    const key = JSON.stringify([keyword, currentPage, filter]);
    const saved = recall(pages, key);
    if (saved) return saved;
    const response = await catalogRequest({ keyword, currentPage, pageSize, ...filter }, signal);
    const data = response?.data?.componentPageInfo;
    const emptyPage =
      data?.list === null && data.pageSize === 0 && (currentPage - 1) * pageSize >= data.total;
    if (
      response?.code !== 200 ||
      !Number.isSafeInteger(data?.total) ||
      data.total < 0 ||
      data.pageNum !== currentPage ||
      (!emptyPage &&
        (!Array.isArray(data.list) ||
          data.list.length > pageSize ||
          data.total < (currentPage - 1) * pageSize + data.list.length ||
          data.pageSize !== pageSize))
    )
      throw new Error('JLCPCB returned an invalid search page.');
    const entries = emptyPage ? [] : data.list.map(entryFor);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('JLCPCB returned duplicate component identities.');
    const page = { entries, total: data.total };
    signal.throwIfAborted();
    remember(pages, key, page, 16);
    return page;
  }

  async function search({ query = '', category = '', offset = 0 }, signal) {
    if (
      typeof query !== 'string' ||
      query.length > 200 ||
      /[\u0000-\u001f]/.test(query) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 999999 ||
      typeof category !== 'string' ||
      (category && !categoryId.test(category))
    )
      throw new Error('Invalid JLCPCB search.');
    const keyword = query.trim();
    const match = category ? (await loadCategories(signal)).filters.get(category) : undefined;
    if (category && !match) throw new Error('Choose an available JLCPCB category.');
    const currentPage = Math.floor(offset / pageSize) + 1;
    const { entries, total } = await loadPage(keyword, currentPage, match?.filter, signal);
    const next = currentPage * pageSize;
    return {
      entries: entries
        .slice(offset % pageSize)
        .filter((entry) => entry.package?.trim() && recall(availability, entry.id) !== false),
      total,
      nextOffset: next < Math.min(total, 1_000_000) ? next : null,
      libraries: ['JLCPCB'],
    };
  }

  async function readCad(code, signal) {
    while (cadReads.size >= concurrentCadReads) {
      await Promise.race(cadReads);
      signal.throwIfAborted();
    }
    const request = readJson(
      'EasyEDA',
      `${cadOrigin}/api/products/${code}/components?version=6.4.19.5`,
      { headers: { Accept: 'application/json' } },
      signal,
    );
    const slot = request.then(
      () => {},
      () => {},
    );
    cadReads.add(slot);
    let response;
    try {
      response = await request;
    } finally {
      cadReads.delete(slot);
    }
    if (response?.success === false && response.code === 404) return;
    if (response?.success !== true || response?.code !== 0)
      throw new Error('EasyEDA could not verify CAD availability. Retry shortly.');
    if (response.result?.lcsc?.number !== code || response.result?.docType !== 2)
      throw new Error('EasyEDA returned a different or unsupported component.');
    return response.result;
  }

  function convert(entry, cad, signal) {
    const converted = convertJlcpcbComponent(entry, cad);
    signal.throwIfAborted();
    if (!converted.symbols.warning) remember(details, entry.id, converted, 16);
    return converted;
  }

  async function detail({ id, kind }, signal) {
    const code = typeof id === 'string' && /^JLCPCB:(C[1-9]\d{0,11})$/.exec(id)?.[1];
    if (!code) throw new Error('Invalid JLCPCB component identity.');
    const saved = recall(details, id);
    if (saved?.[kind]) return saved[kind];
    let entry;
    for (const { value, expires } of pages.values()) {
      if (expires <= Date.now()) continue;
      entry = value.entries.find((item) => item.id === id);
      if (entry) break;
    }
    if (!entry) {
      const { entries } = await loadPage(code, 1, undefined, signal);
      entry = entries.find((item) => item.id === id);
    }
    if (!entry) throw new Error('This component is unavailable in the JLCPCB catalog.');
    const cad = await readCad(code, signal);
    if (!cad) {
      remember(availability, id, false, 1024);
      throw new Error('No EasyEDA CAD data is available for this JLCPCB component.');
    }
    const converted = convert(entry, cad, signal);
    remember(availability, id, Boolean(converted.footprints), 1024);
    if (!converted[kind])
      throw new Error(
        converted.symbols.warning ?? 'This JLCPCB component has no linked footprint.',
      );
    return converted[kind];
  }

  return {
    async request(message) {
      if (shutdown.signal.aborted) throw new Error('JLCPCB library service closed.');
      if (!['symbols', 'footprints'].includes(message.kind))
        throw new Error('Unsupported JLCPCB library kind.');
      if (!['categories', 'search', 'detail'].includes(message.action))
        throw new Error('Unsupported JLCPCB library operation.');
      if (active >= 8) throw new Error('Too many JLCPCB requests. Try again shortly.');
      const signal = AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(20_000),
        ...(message.signal ? [message.signal] : []),
      ]);
      active++;
      try {
        signal.throwIfAborted();
        const result =
          message.action === 'categories'
            ? { categories: (await loadCategories(signal)).categories }
            : await (message.action === 'search'
                ? search(message, signal)
                : detail(message, signal));
        signal.throwIfAborted();
        return structuredClone(result);
      } catch (error) {
        if (signal.aborted)
          throw new Error('JLCPCB request cancelled or timed out. Retry when online.');
        if (error instanceof TypeError)
          throw new Error('JLCPCB request failed. Check your internet connection and retry.');
        throw error;
      } finally {
        active--;
      }
    },
    async modelBytes(reference, signal) {
      const uuid =
        typeof reference === 'string' && /^JLCPCB:([a-f0-9]{32})\.step$/.exec(reference)?.[1];
      if (!uuid) throw new Error('Invalid EasyEDA model reference.');
      if (active >= 8) throw new Error('Too many JLCPCB requests. Try again shortly.');
      active++;
      try {
        const bytes = await readCatalogBytes(
          'EasyEDA',
          fetcher,
          `https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/${uuid}`,
          {},
          32 * 1024 * 1024,
          AbortSignal.any([
            shutdown.signal,
            AbortSignal.timeout(20_000),
            ...(signal ? [signal] : []),
          ]),
        );
        if (!bytes.subarray(0, 100).toString('ascii').includes('ISO-10303-21'))
          throw new Error('EasyEDA returned an invalid STEP model.');
        return bytes;
      } finally {
        active--;
      }
    },
    close() {
      shutdown.abort();
      pages.clear();
      availability.clear();
      details.clear();
      categories = undefined;
    },
  };
}
