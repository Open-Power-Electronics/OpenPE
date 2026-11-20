import { switchingStageFixture } from './fixtures/switching-stage';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  resolveSymbol,
  createLibraryPart,
  partFields,
  parseLibrary,
  symbolUnits,
  symbolAnnotation,
  searchLibrary,
  type LibraryEntry,
} from '../lib/library';
import {
  emptyCircuit,
  libraries,
  pinPositions,
  parseCircuit,
  serializeCircuit,
} from '../lib/circuit';
import { parseSExpr, child, children, val, quote, writeSExpr } from '../lib/sexpr';
import { createProject, serializeProject, parseProject, exportKiCad } from '../lib/project';
import { commitWireRoute, wireRoute, samePoint } from '../lib/wiring';
import { createLibraryService } from '../server/libraries.mjs';
import { readNextpcbSupplyPrices } from '../server/nextpcb-prices.mjs';
import { startServer } from '../server/index.mjs';
import { applyProposal } from '../lib/proposals';

const base = structuredClone(libraries['Device:R']);
base[1] = quote('Base');
const second = structuredClone(children(base, 'symbol')[1]);
second[1] = quote('Base_2_1');
base.push(second);
const derived = parseSExpr(
  '(symbol "Derived" (extends "Base") (property "Value" "precision") (property "Footprint" "Resistor_SMD:R_0805_2012Metric"))',
);

const catalogEntry = (id: string, description = '', keywords = ''): LibraryEntry => ({
  id,
  library: id.split(':')[0],
  name: id.split(':')[1],
  description,
  keywords,
});

test('library search prioritizes exact identities, model prefixes and names over metadata', () => {
  const catalog = [
    catalogEntry('A:Other', 'Alternative to LM358'),
    catalogEntry('B:Other', '', 'LM358'),
    catalogEntry('C:Dual_LM358'),
    catalogEntry('D:LM358AB'),
    catalogEntry('E:LM358A'),
    catalogEntry('Z:LM358'),
  ];
  const before = structuredClone(catalog);
  assert.deepEqual(
    searchLibrary(catalog, '  lM358  ').map((e) => e.id),
    ['Z:LM358', 'E:LM358A', 'D:LM358AB', 'C:Dual_LM358', 'B:Other', 'A:Other'],
  );
  assert.deepEqual(catalog, before);
  assert.equal(searchLibrary(catalog, 'Z:LM358')[0].id, 'Z:LM358');
  assert.deepEqual(
    searchLibrary(catalog, 'lm358', 'A').map((e) => e.id),
    ['A:Other'],
  );
  assert.equal(searchLibrary(catalog, 'lm358 missing').length, 0);
  assert.deepEqual(searchLibrary([...catalog].reverse(), '  '), catalog);
});

test('library search supports short names, whole keywords and terms across fields', () => {
  const catalog = [
    catalogEntry('A:Other', 'resistor'),
    catalogEntry('B:Other', '', 'photoresistor'),
    catalogEntry('C:Other', '', 'resistor'),
    catalogEntry('Device:R', 'Resistor', 'resistor passive'),
    catalogEntry('Device:R_Small', 'Resistor', 'resistor passive'),
  ];
  assert.equal(searchLibrary(catalog, 'r')[0].id, 'Device:R');
  assert.deepEqual(
    searchLibrary(catalog, 'resistor').map((e) => e.id),
    ['Device:R', 'Device:R_Small', 'C:Other', 'B:Other', 'A:Other'],
  );
  assert.deepEqual(
    searchLibrary(catalog, 'device   passive resistor').map((e) => e.id),
    ['Device:R', 'Device:R_Small'],
  );
});

test('library worker ranks saved symbol and footprint catalogs before bounded pagination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-search-'));
  const entries = [
    ...Array.from({ length: 105 }, (_, i) =>
      catalogEntry(`A:Part_${String(i).padStart(3, '0')}`, 'LM358 replacement'),
    ),
    catalogEntry('Z:LM358'),
  ];
  const modelFootprint = catalogEntry('Fixture:WithModel');
  const plainFootprint = catalogEntry('Fixture:WithoutModel');
  entries[0].footprint = modelFootprint.id;
  entries[1].footprint = plainFootprint.id;
  entries[2].footprint = 'Fixture:Missing';
  entries[3].footprint = 'Resistor_SMD:R_0603_1608Metric';
  entries[4].footprint = 'Resistor_SMD:R_0201_0603Metric';
  entries[5].footprint = 'Package_TO_SOT_SMD:SOT-23-5';
  await writeFile(
    path.join(root, 'with-model.kicad_mod'),
    '(footprint "WithModel" (version 20260206) (model "${KICAD10_3DMODEL_DIR}/Fixture.3dshapes/WithModel.step"))',
  );
  await writeFile(
    path.join(root, 'without-model.kicad_mod'),
    '(footprint "WithoutModel" (version 20260206))',
  );
  await writeFile(
    path.join(root, 'library-index.json'),
    JSON.stringify({
      version: 1,
      catalogs: { symbols: entries, footprints: [...entries, modelFootprint, plainFootprint] },
      files: [
        [`footprints:${modelFootprint.id}`, 'with-model.kicad_mod'],
        [`footprints:${plainFootprint.id}`, 'without-model.kicad_mod'],
      ],
    }),
  );
  const service = createLibraryService({ root, dataDir: root });
  try {
    for (const kind of ['symbols', 'footprints']) {
      const first = await service.request({ action: 'search', kind, query: 'lm358' });
      const second = await service.request({ action: 'search', kind, query: 'lm358', offset: 100 });
      assert.equal(first.entries[0].id, 'Z:LM358');
      assert.equal(first.total, 106);
      assert.equal(first.entries.length, 100);
      assert.equal(second.total, 106);
      assert.equal(second.entries.length, 6);
      assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.id)).size, 106);
      const filtered = await service.request({
        action: 'search',
        kind,
        query: 'lm358',
        library: 'Z',
      });
      assert.equal(filtered.total, 1);
      assert.equal(filtered.entries[0].id, 'Z:LM358');
      const changed = await service.request({ action: 'search', kind, query: 'part_104' });
      assert.deepEqual(
        changed.entries.map((entry: LibraryEntry) => entry.id),
        ['A:Part_104'],
      );
      const empty = await service.request({ action: 'search', kind, query: 'no matching part' });
      assert.equal(empty.total, 0);
      const returned = await service.request({
        action: 'search',
        kind,
        query: 'lm358',
        offset: 100,
      });
      assert.deepEqual(returned, second, 'Changing filters or queries cannot reuse stale pages.');
    }
    for (const query of ['Fixture:WithModel', 'withmodel', 'LM358 WithModel', 'package:With-Model']) {
      const found = await service.request({ action: 'search', kind: 'symbols', query });
      assert.deepEqual(found.entries.map(({ id }: LibraryEntry) => id), [entries[0].id], query);
    }
    for (const [query, index] of [['0603', 3], ['sot23', 5]] as const) {
      const found = await service.request({ action: 'search', kind: 'symbols', query });
      assert.deepEqual(found.entries.map(({ id }: LibraryEntry) => id), [entries[index].id], query);
    }
    const verified = await service.request({
      action: 'search',
      kind: 'symbols',
      query: 'lm358',
      includeAssetStatus: true,
    });
    assert.equal(verified.entries.length, 16);
    assert.equal(verified.nextOffset, 16);
    assert.deepEqual(
      verified.entries.slice(0, 4).map((entry: LibraryEntry) => entry.footprintPreview),
      ['unavailable', '2d-and-3d', '2d', undefined],
    );
    const continued = await service.request({
      action: 'search',
      kind: 'symbols',
      query: 'lm358',
      offset: verified.nextOffset,
      includeAssetStatus: true,
    });
    assert.equal(continued.entries[0].id, 'A:Part_015');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('NextPCB service routing needs no bundled resources and ordinary searches stay local', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openpe-nextpcb-routing-'));
  const root = path.join(temporary, 'not-prepared');
  const id = 'NextPCB:9728_LM358';
  const symbolUrl = 'https://file.eda.cn/web1/M00/fixture/LM358.kicad_sym';
  const footprintUrl = 'https://file.eda.cn/web1/M00/fixture/LM358.kicad_mod';
  const nativeSymbol = structuredClone(libraries['Device:R']);
  nativeSymbol[1] = quote('LM358');
  children(nativeSymbol, 'property').find((node) => val(node) === 'Reference')![2] = quote('U?');
  const requests: string[] = [];
  const nextpcbFetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    requests.push(url);
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'omit');
    assert.ok(options?.signal instanceof AbortSignal);
    if (url === 'https://library.nextpcb.com/api/chiplet/products/kicad/queryPage') {
      assert.equal(options?.method, 'POST');
      assert.equal(JSON.parse(String(options?.body)).desc, 'LM358');
      return Response.json({
        code: 200000,
        total: 1,
        result: [
          {
            manufacturer_id: 9728,
            mpn: 'LM358',
            manufacturer: 'Fixture Components',
            Description: 'Synthetic native fixture',
            footprintFileUrl: footprintUrl,
          },
        ],
      });
    }
    if (url === 'https://library.nextpcb.com/api/chiplet/kicad/productDetail') {
      assert.deepEqual(JSON.parse(String(options?.body)), {
        manufacturer_id: '9728',
        mpn: 'LM358',
      });
      return Response.json({
        code: 200000,
        result: {
          mfgId: 9728,
          mpn: 'LM358',
          mfg: 'Fixture Components',
          description: 'Synthetic native fixture',
          cadUrlList: [
            { type: 'symbol', fileUrl: symbolUrl },
            { type: 'footprint', fileUrl: footprintUrl },
          ],
        },
      });
    }
    if (url === symbolUrl)
      return new Response(writeSExpr(['kicad_symbol_lib', ['version', '20251024'], nativeSymbol]));
    if (url === footprintUrl)
      return new Response(
        '(footprint "LM358" (version 20260206) (layer "F.Cu") (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))',
      );
    throw new Error(`Unexpected remote fixture request: ${url}`);
  };
  const service = createLibraryService({ root, dataDir: temporary, nextpcbFetcher });
  try {
    const search = await service.request({
      action: 'search',
      kind: 'symbols',
      library: 'NextPCB',
      query: 'LM358',
    });
    assert.equal(search.entries[0].id, id);
    assert.deepEqual(search.libraries, ['NextPCB']);
    assert.equal(search.entries[0].footprintPreview, undefined);
    const progress: unknown[] = [];
    const verified = await service.request({
      action: 'search',
      kind: 'symbols',
      library: 'NextPCB',
      query: 'LM358',
      includeAssetStatus: true,
      onProgress: (count) => progress.push(count),
    });
    assert.deepEqual(progress, [
      { completed: 0, total: 1 },
      { completed: 1, total: 1 },
    ]);
    assert.equal(verified.entries[0].footprintPreview, '2d');
    assert.equal(verified.nextOffset, null);
    assert.equal(requests.length, 4);
    const detail = await service.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(detail.error, undefined);
    assert.equal(detail.warning, undefined);
    assert.equal(val(detail.symbol), id);
    assert.equal(detail.footprint, id);
    const footprint = await service.request({ action: 'detail', kind: 'footprints', id });
    assert.deepEqual(footprint.pads, ['1', '2']);
    assert.deepEqual(footprint.models, []);
    assert.equal(requests.length, 4);
    assert.deepEqual(
      await readdir(temporary),
      [],
      'Online browsing does not prepare local resources or write a cache.',
    );

    // Prepare a separate tiny local catalog only after the online requests have succeeded.
    await mkdir(root);
    await writeFile(
      path.join(root, 'library-index.json'),
      JSON.stringify({
        version: 1,
        catalogs: { symbols: [catalogEntry('Fixture:Local', 'LM358 fixture')], footprints: [] },
        files: [],
      }),
    );
    const local = await service.request({ action: 'search', kind: 'symbols', query: 'LM358' });
    assert.deepEqual(
      local.entries.map((entry: LibraryEntry) => entry.id),
      ['Fixture:Local'],
    );
    assert.deepEqual(local.libraries, ['Fixture']);
    assert.equal(requests.length, 4, 'All-library searches never contact NextPCB implicitly.');
    service.close();
    await assert.rejects(service.request({ action: 'detail', kind: 'symbols', id }), /closed/);
    assert.equal(requests.length, 4);
  } finally {
    service.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authenticated NextPCB HTTP reads browse suggestions and accept cross-category keyword searches', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openpe-nextpcb-http-'));
  const requests: string[] = [];
  const nextpcbFetcher: typeof fetch = async (input, options) => {
    requests.push(String(input));
    if (String(input).endsWith('/productDetail')) return new Response(null, { status: 403 });
    if (String(input).endsWith('/cateTree'))
      return Response.json({
        code: 200000,
        result: [
          {
            cateId: 1737,
            cateDisplayName: 'Operational Amplifier and Comparators',
            parentId: 0,
            level: 1,
          },
        ],
      });
    assert.equal(String(input), 'https://library.nextpcb.com/api/chiplet/products/kicad/queryPage');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'omit');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(options?.body)), {
      pageNum: 1,
      pageSize: 50,
      haveEdaModel: 1,
      have3dModel: 0,
      haveSimModel: 0,
      haveSupplierModel: 0,
      ...(requests.length === 2 ? { cateId: 1737 } : { desc: 'LM358' }),
    });
    return Response.json({
      code: 200000,
      total: 1,
      result: [
        {
          manufacturer_id: '9728',
          mpn: 'LM358',
          manufacturer: 'Fixture Components',
          footprintFileUrl: 'https://file.eda.cn/web1/M00/vendor.kicad_mod',
        },
      ],
    });
  };
  const server = await startServer({
    dataDir: path.join(temporary, 'state'),
    libraryRoot: path.join(temporary, 'not-prepared'),
    nextpcbFetcher,
  });
  try {
    const headers = { 'X-OpenPE-Token': server.token };
    const empty = await fetch(server.base + '/api/libraries/symbols?library=NextPCB', { headers });
    assert.equal(empty.status, 200);
    assert.equal((await empty.json()).entries[0].id, 'NextPCB:9728_LM358');
    assert.equal(requests.length, 2);
    const response = await fetch(server.base + '/api/libraries/symbols?library=NextPCB&q=LM358', {
      headers,
    });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.total, 1);
    assert.equal(page.nextOffset, null);
    assert.equal(page.entries[0].id, 'NextPCB:9728_LM358');
    assert.equal(requests.length, 3);
    const streamed = await fetch(
      server.base + '/api/libraries/symbols?library=NextPCB&q=LM358&includeAssetStatus=1',
      { headers: { ...headers, Accept: 'application/x-ndjson' } },
    );
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get('content-type') ?? '', /^application\/x-ndjson/);
    const frames = (await streamed.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(frames, [
      { type: 'progress', completed: 0, total: 1 },
      { type: 'result', result: page },
    ]);
  } finally {
    server.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authenticated NextPCB pricing uses the selected CAD identity and refreshes live quotes', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openpe-nextpcb-price-'));
  const staticDir = path.join(temporary, 'renderer');
  const renderer = '<!DOCTYPE html><title>OpenPE</title>';
  const priceUrl = 'https://library.nextpcb.com/api/chiplet/kicad/searchSupplyChain';
  let lookups = 0;
  const nextpcbFetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith('/queryPage'))
      return Response.json({
        code: 200000,
        total: 1,
        result: [{ manufacturer_id: '9728', mpn: 'LM358' }],
      });
    if (url.endsWith('/productDetail'))
      return Response.json({
        code: 200000,
        result: { mfgId: 9728, mpn: 'LM358', mfg: 'Texas Instruments (TI)' },
      });
    assert.equal(url, priceUrl);
    assert.equal(options?.method, 'POST');
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(options?.body)), ['9728-LM358']);
    lookups++;
    if (lookups === 5)
      return new Response('<!DOCTYPE html><title>Huaqiu</title>', {
        headers: { 'Content-Type': 'text/html' },
      });
    const offer = supplyOffer({
      price: [
        { breakMin: 10, usd: lookups === 4 ? -1 : 0.08 },
        { breakMin: 1, usd: 0.1 + lookups },
      ],
    });
    return Response.json({
      code: 200000,
      result: [
        { ...offer, mfgId: 4, sku: 'OTHER-MANUFACTURER' },
        { ...offer, mpn: 'LM358D', sku: 'OTHER-PART' },
        { ...offer, vendor: 'other', sku: 'OTHER-VENDOR' },
        ...(lookups === 3 ? [] : [offer]),
      ],
    });
  };
  await mkdir(staticDir);
  await writeFile(path.join(staticDir, 'index.html'), renderer);
  const server = await startServer({
    dataDir: temporary,
    staticDir,
    nextpcbFetcher,
  });
  const headers = { 'X-OpenPE-Token': server.token };
  const price = server.base + '/api/library-price?id=NextPCB%3A9728_LM358&kind=symbols&source=huaqiu';
  try {
    const search = await fetch(server.base + '/api/libraries/symbols?library=NextPCB&q=LM358', {
      headers,
    });
    assert.equal(search.status, 200);
    assert.equal((await search.json()).entries[0].id, 'NextPCB:9728_LM358');
    assert.equal((await fetch(price)).status, 401);
    assert.equal(
      (await fetch(price, { headers: { ...headers, Origin: 'https://example.invalid' } })).status,
      403,
    );
    assert.equal((await fetch(price + '&url=elsewhere', { headers })).status, 400);
    assert.equal((await fetch(price + '&source=lcsc', { headers })).status, 400);
    assert.equal(
      (await fetch(price.replace('source=huaqiu', 'source=unsupported'), { headers })).status,
      400,
    );
    const missing = await fetch(server.base + '/api/library-price-missing', { headers });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Unknown OpenPE API route.' });
    assert.equal(await (await fetch(server.base + '/workbench')).text(), renderer);
    assert.equal(lookups, 0);
    for (const unitPrice of [1.1, 2.1]) {
      const response = await fetch(price, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const quote = await response.json();
      assert.equal(quote.source, 'huaqiu');
      assert.equal(quote.currency, 'USD');
      assert.ok(Number.isSafeInteger(quote.checkedAt));
      assert.deepEqual(quote.offers, [
        {
          sku: '2500013854',
          manufacturer: null,
          stock: 20,
          tiers: [
            { quantity: 1, unitPrice },
            { quantity: 10, unitPrice: 0.08 },
          ],
        },
      ]);
    }
    assert.deepEqual((await (await fetch(price, { headers })).json()).offers, []);
    assert.equal((await fetch(price, { headers })).status, 422);
    const upstreamHtml = await fetch(price, { headers });
    assert.equal(upstreamHtml.status, 422);
    assert.deepEqual(await upstreamHtml.json(), {
      error: 'Huaqiu returned an invalid supply-chain pricing response.',
    });
    const recovered = await fetch(price, { headers });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).offers[0].tiers[0].unitPrice, 6.1);
    assert.equal(lookups, 6);
  } finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

function supplyOffer(overrides: Record<string, unknown> = {}) {
  return {
    mfgId: 9728,
    mpn: 'LM358',
    vendor: 'hqself',
    sku: '2500013854',
    stock: 20,
    price: [{ breakMin: 5, usd: 0.08 }],
    ...overrides,
  };
}

test('Huaqiu batch results preserve identities and distinguish omitted, unpriced and malformed entries', async () => {
  const parts = [
    { manufacturer_id: '9728', mpn: 'LM358' },
    { manufacturer_id: '4', mpn: 'LM358' },
    { manufacturer_id: '9728', mpn: 'LM358D' },
    { manufacturer_id: '5', mpn: 'LM358' },
    { manufacturer_id: '9728', mpn: 'LM358/NS-NOPB' },
    { manufacturer_id: '6', mpn: 'LM358' },
  ];
  let requested = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    requested++;
    assert.deepEqual(JSON.parse(String(init?.body)), [
      '9728-LM358',
      '4-LM358',
      '9728-LM358D',
      '5-LM358',
      '9728-LM358/NS-NOPB',
      '6-LM358',
    ]);
    return Response.json({
      code: 200000,
      result: [
        supplyOffer({ mfgId: '4', sku: 'OTHER', stock: 0 }),
        supplyOffer({ mfgId: 5, price: [{ breakMin: 0, usd: 1 }] }),
        supplyOffer({ mpn: 'LM358D', price: [{ breakMin: 1, usd: null, rmb: 1 }] }),
        supplyOffer({ mpn: 'LM358/NS', sku: 'SUBSTRING' }),
        supplyOffer({ mfgId: 6, price: null, stock: 0 }),
        supplyOffer(),
        supplyOffer(),
      ],
    });
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    readNextpcbSupplyPrices(fetcher, [{ ...parts[0], mpn: '' }], signal),
    /invalid.*identity/i,
  );
  await assert.rejects(
    readNextpcbSupplyPrices(fetcher, [parts[0], parts[0]], signal),
    /duplicate.*identity/i,
  );
  assert.equal(requested, 0);
  const results = await readNextpcbSupplyPrices(fetcher, parts, signal);
  assert.equal(results.length, parts.length);
  assert.deepEqual(
    results[0].quote.offers.map((offer) => offer.sku),
    ['2500013854'],
  );
  assert.deepEqual(results[1].quote.offers, [
    {
      sku: 'OTHER',
      manufacturer: null,
      stock: 0,
      tiers: [{ quantity: 5, unitPrice: 0.08 }],
    },
  ]);
  assert.deepEqual(results[2].quote.offers, []);
  assert.equal(results[2].error, undefined);
  assert.match(results[3].error ?? '', /invalid supply-chain pricing response/);
  assert.deepEqual(results[4].quote.offers, []);
  assert.equal(results[4].error, undefined);
  assert.deepEqual(results[5].quote.offers, []);
  assert.equal(results[5].error, undefined);
});

function nextPcbOfficialModelFixture() {
  const id = 'NextPCB:9728_LM358';
  const reference = '${KICAD6_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl';
  const symbolUrl = 'https://file.eda.cn/web1/M00/fixture/model.kicad_sym';
  const footprintUrl = 'https://file.eda.cn/web1/M00/fixture/model.kicad_mod';
  const nativeSymbol = structuredClone(libraries['Device:R']);
  nativeSymbol[1] = quote('LM358');
  const calls: string[] = [];
  const nextpcbFetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    calls.push(url);
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'omit');
    assert.ok(options?.signal instanceof AbortSignal);
    if (url === 'https://library.nextpcb.com/api/chiplet/kicad/productDetail')
      return Response.json({
        code: 200000,
        result: {
          mfgId: 9728,
          mpn: 'LM358',
          cadUrlList: [
            { type: 'symbol', fileUrl: symbolUrl },
            { type: 'footprint', fileUrl: footprintUrl },
          ],
        },
      });
    if (url === symbolUrl)
      return new Response(writeSExpr(['kicad_symbol_lib', ['version', '20251024'], nativeSymbol]));
    if (url === footprintUrl)
      return new Response(
        `(footprint "LM358" (version 20260206) (layer "F.Cu")
          (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
          (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
          (model ${quote(reference)} (offset (xyz 1 2 3))
            (scale (xyz 1 0.5 2)) (rotate (xyz 0 45 90))))`,
      );
    throw new Error('Unexpected NextPCB fixture request.');
  };
  const footprintRequests = [
    'https://library.nextpcb.com/api/chiplet/kicad/productDetail',
    footprintUrl,
  ];
  return { id, reference, calls, nextpcbFetcher, footprintRequests };
}

test('NextPCB model indices resolve prepared official STEP bytes with a borrowed parser and preserve the declared pose', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openpe-nextpcb-prepared-model-'));
  const root = path.join(temporary, 'resources');
  const directory = path.join(root, 'models', 'Package_SO.3dshapes');
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('ISO-10303-21;\nprepared official fixture');
  await writeFile(path.join(directory, 'SOIC-8.step'), bytes);
  const fixture = nextPcbOfficialModelFixture();
  let parsed = 0;
  let parserClosed = false;
  let downloads = 0;
  const library = createLibraryService({
    root,
    dataDir: temporary,
    nextpcbFetcher: fixture.nextpcbFetcher,
    modelFetcher: async () => {
      downloads++;
      throw new Error('Prepared models must not download.');
    },
    stepParserPool: {
      run: async (input: Uint8Array, signal?: AbortSignal) => {
        assert.deepEqual(Buffer.from(input), bytes);
        assert.ok(signal instanceof AbortSignal);
        parsed++;
        return { meshes: [] };
      },
      close: () => {
        parserClosed = true;
      },
    },
  });
  try {
    const detail = await library.request({ action: 'detail', kind: 'footprints', id: fixture.id });
    assert.equal(detail.models[0].path, fixture.reference);
    assert.equal(parsed, 0, 'Catalog reads do not parse or download a model.');
    const result = await library.model(fixture.id, 0, new AbortController().signal);
    assert.deepEqual(result.meshes, []);
    assert.deepEqual(result.model, detail.models[0]);
    assert.deepEqual(Buffer.from(await library.componentModelBytes(fixture.id, 0)), bytes);
    assert.equal(parsed, 1);
    assert.equal(downloads, 0);
    assert.deepEqual(fixture.calls, fixture.footprintRequests);
    await assert.rejects(library.model(fixture.id, 1), /No model is assigned/);
    assert.equal(downloads, 0);
    library.close();
    assert.equal(parserClosed, false, 'The borrowed parser retains its owner.');
  } finally {
    library.close();
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('openpe-nextpcb-prepared-model-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('official model cache misses use only the fixed KiCad release transport and malformed paths never reach it', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openpe-nextpcb-model-download-'));
  const fixture = nextPcbOfficialModelFixture();
  const bytes = Buffer.from('ISO-10303-21;\ndownloaded official fixture');
  const downloads: string[] = [];
  let parsed = 0;
  const library = createLibraryService({
    root: path.join(temporary, 'not-prepared'),
    dataDir: temporary,
    nextpcbFetcher: fixture.nextpcbFetcher,
    modelFetcher: async (input, options) => {
      downloads.push(String(input));
      assert.equal(
        String(input),
        'https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/10.0.0/Package_SO.3dshapes/SOIC-8.step',
      );
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal instanceof AbortSignal);
      return new Response(bytes);
    },
    stepParserPool: {
      run: async (input: Uint8Array) => {
        assert.deepEqual(Buffer.from(input), bytes);
        parsed++;
        return { meshes: [] };
      },
      close() {},
    },
  });
  try {
    for (const reference of [
      'https://example.com/foreign.step',
      '/private/foreign.step',
      '${KIPRJMOD}/models/foreign.step',
      '${KICAD10_3DMODEL_DIR}/../foreign.step',
      '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/../../foreign.step',
      '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/foreign.step?url=http://127.0.0.1',
    ])
      await assert.rejects(library.modelPath(reference), /reference|official STEP path/);
    assert.equal(downloads.length, 0);
    await library.model(fixture.id, 0);
    await library.modelPath('${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step');
    assert.equal(
      downloads.length,
      1,
      'The verified official bytes are reused from their fixed cache.',
    );
    assert.equal(parsed, 2);
    assert.deepEqual(fixture.calls, fixture.footprintRequests);
  } finally {
    library.close();
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('openpe-nextpcb-model-download-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('authenticated NextPCB model HTTP reads use the fixed official transport and leave 2D detail usable on a missing model', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'openpe-nextpcb-model-http-'));
  const fixture = nextPcbOfficialModelFixture();
  const downloads: string[] = [];
  const server = await startServer({
    dataDir: path.join(temporary, 'state'),
    libraryRoot: path.join(temporary, 'not-prepared'),
    nextpcbFetcher: fixture.nextpcbFetcher,
    libraryModelFetcher: async (input, options) => {
      downloads.push(String(input));
      assert.equal(
        String(input),
        'https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/10.0.0/Package_SO.3dshapes/SOIC-8.step',
      );
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal instanceof AbortSignal);
      return new Response(null, { status: 404 });
    },
  });
  try {
    const route = `/api/library-model?id=${encodeURIComponent(fixture.id)}&index=0`;
    assert.equal((await fetch(server.base + route)).status, 401);
    assert.equal(fixture.calls.length, 0);
    assert.equal(downloads.length, 0);
    const headers = { 'X-OpenPE-Token': server.token };
    const missing = await fetch(server.base + route, { headers });
    assert.equal(missing.status, 422);
    const failure = await missing.json();
    assert.equal(failure.code, 'OPENPE_LIBRARY_ASSET_UNAVAILABLE');
    assert.match(
      failure.error,
      /not available in the official KiCad 10\.0\.0 library.*2D footprint/,
    );
    assert.equal(downloads.length, 1);
    const footprint = await fetch(
      `${server.base}/api/libraries/footprints?id=${encodeURIComponent(fixture.id)}`,
      { headers },
    );
    assert.equal(footprint.status, 200);
    const detail = await footprint.json();
    assert.deepEqual(detail.pads, ['1', '2']);
    assert.equal(detail.models[0].path, fixture.reference);
    assert.equal(
      downloads.length,
      1,
      'Viewing accepted 2D geometry does not repeat a model download.',
    );
    assert.deepEqual(fixture.calls, fixture.footprintRequests);
  } finally {
    server.close();
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('openpe-nextpcb-model-http-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('library category discovery separates local namespaces and the authenticated NextPCB category tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-library-categories-'));
  const remoteBodies: unknown[] = [];
  const nextpcbFetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    remoteBodies.push(JSON.parse(String(options?.body)));
    assert.equal(options?.redirect, 'error');
    if (url.endsWith('/cateTree'))
      return Response.json({
        code: 200000,
        result: [
          { cateId: 1737, cateDisplayName: 'Amplifiers', parentId: 0, level: 1 },
          { cateId: 1805, cateDisplayName: 'Zero Drift Amplifiers', parentId: 1737, level: 2 },
        ],
      });
    if (url.endsWith('/queryPage')) return Response.json({ code: 200000, total: 0, result: [] });
    throw new Error('Unexpected category fixture request.');
  };
  await writeFile(
    path.join(root, 'library-index.json'),
    JSON.stringify({
      version: 1,
      catalogs: {
        symbols: [catalogEntry('Device:R'), catalogEntry('Amplifier_Operational:LM358')],
        footprints: [catalogEntry('Package_SO:SOIC-8')],
      },
      files: [],
    }),
  );
  const service = createLibraryService({ root, dataDir: root, nextpcbFetcher });
  const server = await startServer({
    dataDir: path.join(root, 'state'),
    libraryRoot: root,
    nextpcbFetcher,
  });
  const headers = { 'X-OpenPE-Token': server.token };
  try {
    assert.deepEqual(
      await service.request({ action: 'categories', kind: 'symbols', source: 'KiCad' }),
      {
        categories: [
          { id: 'Amplifier_Operational', name: 'Amplifier_Operational', children: [] },
          { id: 'Device', name: 'Device', children: [] },
        ],
      },
    );
    assert.deepEqual(
      await service.request({ action: 'categories', kind: 'footprints', source: 'KiCad' }),
      {
        categories: ['EMC_Demo', 'Inductor_SMD_Wurth', 'Package_SO'].map((id) => ({
          id,
          name: id,
          children: [],
        })),
      },
    );
    assert.equal(remoteBodies.length, 0, 'KiCad categories never query the remote provider.');
    await assert.rejects(
      service.request({ action: 'categories', kind: 'symbols', source: 'foreign' }),
      /supported library/,
    );
    await assert.rejects(
      service.request({ action: 'search', kind: 'symbols', library: 'Device', category: '1737' }),
      /only to online library searches/,
    );
    assert.equal(
      (await fetch(`${server.base}/api/libraries/symbols?categories=NextPCB`)).status,
      401,
    );
    const remote = await fetch(`${server.base}/api/libraries/symbols?categories=NextPCB`, {
      headers,
    });
    assert.equal(remote.status, 200);
    assert.deepEqual(await remote.json(), {
      categories: [
        {
          id: '1737',
          name: 'Amplifiers',
          children: [{ id: '1805', name: 'Zero Drift Amplifiers', children: [] }],
        },
      ],
    });
    assert.equal(
      (
        await fetch(`${server.base}/api/libraries/symbols?library=NextPCB&category=1805&q=LM358`, {
          headers,
        })
      ).status,
      200,
    );
    assert.deepEqual(remoteBodies, [
      {},
      {
        pageNum: 1,
        pageSize: 50,
        haveEdaModel: 1,
        have3dModel: 0,
        haveSimModel: 0,
        haveSupplierModel: 0,
        desc: 'LM358',
        cateId: 1805,
      },
    ]);
    for (const query of [
      'categories=foreign',
      'categories=NextPCB&q=LM358',
      'categories=NextPCB&categories=KiCad',
      'library=Device&category=1805',
      'library=NextPCB&category=01805',
      'library=NextPCB&category=https://foreign.example',
    ])
      assert.equal(
        (await fetch(`${server.base}/api/libraries/symbols?${query}`, { headers })).status,
        400,
      );
    const unknown = await fetch(
      `${server.base}/api/libraries/symbols?library=NextPCB&category=9999`,
      { headers },
    );
    assert.equal(unknown.status, 422);
    assert.equal(remoteBodies.length, 2, 'Unavailable categories never reach product search.');
  } finally {
    service.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('official example annotations stay outside bodies and use identical positions in native exports', () => {
  const d = switchingStageFixture();
  const exported = children(parseSExpr(serializeCircuit(d)), 'symbol');
  for (const [i, part] of d.parts.entries()) {
    const reference = symbolAnnotation(part, d.libraries[part.libId], 'Reference')!;
    const value = symbolAnnotation(part, d.libraries[part.libId], 'Value')!;
    if (!part.ref.startsWith('#')) assert.ok(Math.abs(reference.y - value.y) >= 2.5);
    for (const name of ['Reference', 'Value'] as const) {
      const actual = child(
        children(exported[i], 'property').find((p) => val(p) === name)!,
        'at',
      )!;
      const position = symbolAnnotation(part, d.libraries[part.libId], name)!;
      assert.ok(Math.abs(Number(actual[1]) - position.x) < 0.0001);
      assert.ok(Math.abs(Number(actual[2]) - position.y) < 0.0001);
    }
  }
  const resistor = d.parts.find((p) => p.ref === 'R1')!;
  assert.ok(
    symbolAnnotation(resistor, d.libraries[resistor.libId], 'Value')!.x > resistor.x + 1.27,
  );
});

test('inherited symbols are self-contained and units preserve pins, fields and identity through JSON and KiCad', () => {
  const symbol = resolveSymbol([base, derived], 'Derived', 'Test');
  assert.equal(child(symbol, 'extends'), undefined);
  assert.equal(symbolUnits(symbol), 2);
  const d = emptyCircuit();
  d.libraries['Test:Derived'] = symbol;
  const a = createLibraryPart(d, symbol, 10.16, 20.32, 1);
  d.parts.push(a);
  const b = createLibraryPart(d, symbol, 30.48, 20.32, 2);
  d.parts.push(b);
  assert.equal(a.ref, b.ref);
  assert.equal(pinPositions(a, symbol).length, 2);
  assert.equal(pinPositions(b, symbol).length, 2);
  a.fields!.Tolerance = '1%';
  b.fields!.Tolerance = '1%';
  const project = createProject(d);
  const recovered = parseProject(serializeProject(project));
  assert.equal(serializeProject(recovered), serializeProject(project));
  const imported = parseCircuit(exportKiCad(recovered, 'schematic'));
  assert.deepEqual(
    imported.parts.map((p) => p.id),
    d.parts.map((p) => p.id),
  );
  assert.equal(imported.parts[1].unit, 2);
  assert.equal(partFields(imported.parts[0]).Footprint, 'Resistor_SMD:R_0805_2012Metric');
  assert.equal(partFields(imported.parts[1]).Tolerance, '1%');
  assert.equal(
    serializeCircuit(parseCircuit(serializeCircuit(imported))),
    serializeCircuit(imported),
  );
  const stale = structuredClone(project);
  stale.schematic.parts[1].value = 'different';
  assert.throws(() => serializeProject(stale), /inconsistent units/);
  const edited = applyProposal(d, [{ type: 'setValue', ref: a.ref, value: 'matched pair' }]);
  assert.ok(edited.parts.every((p) => p.value === 'matched pair'));
  assert.equal(applyProposal(edited, [{ type: 'removePart', ref: a.ref }]).parts.length, 0);
  assert.equal(d.parts.length, 2);
  assert.throws(
    () =>
      resolveSymbol(
        [parseSExpr('(symbol "a" (extends "b"))'), parseSExpr('(symbol "b" (extends "a"))')],
        'a',
        'Test',
      ),
    /Circular/,
  );
});

test('wire routing splits T connections, preserves crossing isolation, UUIDs and source data', () => {
  const d = emptyCircuit();
  d.wires = [{ id: crypto.randomUUID(), a: { x: 0, y: 5.08 }, b: { x: 10.16, y: 5.08 } }];
  const original = structuredClone(d);
  const cross = commitWireRoute(d, [
    { x: 5.08, y: 0 },
    { x: 5.08, y: 10.16 },
  ]);
  assert.equal(cross.junctions.length, 0);
  assert.equal(cross.wires.length, 2);
  const tee = commitWireRoute(d, wireRoute({ x: 5.08, y: 0 }, { x: 5.08, y: 5.08 }));
  assert.equal(tee.wires.length, 3);
  assert.equal(tee.junctions.length, 1);
  assert.equal(tee.wires[0].id, d.wires[0].id);
  assert.equal(
    tee.wires.filter((w) => samePoint(w.a, tee.junctions[0]) || samePoint(w.b, tee.junctions[0]))
      .length,
    3,
  );
  assert.deepEqual(d, original);
  assert.deepEqual(wireRoute({ x: 0, y: 0 }, { x: 5.08, y: 5.08 }, true), [
    { x: 0, y: 0 },
    { x: 0, y: 5.08 },
    { x: 5.08, y: 5.08 },
  ]);
  serializeProject(createProject(tee));
  const repeated = commitWireRoute(tee, [
    { x: 5.08, y: 0 },
    { x: 5.08, y: 5.08 },
  ]);
  assert.equal(repeated.wires.length, 3);
});

test('bundled library service indexes unpacked KiCad 10 symbols, rejects unknown IDs and enforces HTTP access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-libraries-'));
  await mkdir(path.join(root, 'symbols', 'Test.kicad_symdir'), { recursive: true });
  await mkdir(path.join(root, 'footprints', 'Test.pretty'), { recursive: true });
  await writeFile(
    path.join(root, 'symbols', 'Test.kicad_symdir', 'Base.kicad_sym'),
    writeSExpr(['kicad_symbol_lib', ['version', '20251024'], base]),
  );
  await writeFile(
    path.join(root, 'symbols', 'Test.kicad_symdir', 'Derived.kicad_sym'),
    writeSExpr(['kicad_symbol_lib', ['version', '20251024'], derived]),
  );
  await writeFile(
    path.join(root, 'footprints', 'Test.pretty', 'R.kicad_mod'),
    '(footprint "R" (version 20260206) (pad "1" smd rect (at 0 0) (size 1 1)) (model "../../secrets.step"))',
  );
  const service = createLibraryService({ root, dataDir: root });
  const server = await startServer({ dataDir: path.join(root, 'state'), libraryRoot: root });
  try {
    assert.equal((await service.request({ action: 'status' })).symbols, 2);
    const result = await service.request({ action: 'search', kind: 'symbols', query: 'precision' });
    // Search is by library identity, description and keywords, rather than arbitrary field values.
    assert.equal(result.total, 0);
    const detail = await service.request({ action: 'detail', kind: 'symbols', id: 'Test:Derived' });
    assert.equal(detail.units, 2);
    assert.equal(detail.error, undefined);
    await assert.rejects(
      service.request({ action: 'detail', kind: 'symbols', id: '../../secret' }),
      /Unknown/,
    );
    await assert.rejects(service.model('Test:R', 0), /supported official STEP path/);
    assert.equal((await fetch(server.base + '/api/libraries/symbols')).status, 401);
    const headers = { 'X-OpenPE-Token': server.token };
    assert.equal(
      (
        await fetch(server.base + '/api/libraries/symbols', {
          headers: { ...headers, Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    const response = await fetch(server.base + '/api/libraries/symbols?q=Derived', { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).entries[0].id, 'Test:Derived');
    assert.equal((await fetch(server.base + '/api/libraries/unknown', { headers })).status, 400);
  } finally {
    service.close();
    server.close();
  }
});

test('library readers reject future versions and malformed symbols before placement', () => {
  assert.throws(() => parseLibrary('(kicad_symbol_lib (version 20990101))'), /Unsupported/);
  const symbol = resolveSymbol([base], 'Base', 'Test');
  const d = emptyCircuit();
  d.libraries['Test:Base'] = symbol;
  const p = createLibraryPart(d, symbol, 0, 0, 3);
  d.parts.push(p);
  assert.throws(() => serializeProject(createProject(d)), /unit is missing/);
  assert.equal(val(symbol), 'Test:Base');
});

test('missing official models explain the unavailable preview and keep footprint details usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-missing-model-'));
  await mkdir(path.join(root, 'symbols'), { recursive: true });
  await mkdir(path.join(root, 'footprints', 'Audio_Module.pretty'), { recursive: true });
  await writeFile(
    path.join(root, 'footprints', 'Audio_Module.pretty', 'Reverb_BTDR-1H.kicad_mod'),
    '(footprint "Reverb_BTDR-1H" (version 20260206) (pad "1" thru_hole circle (at 0 0) (size 2 2)) (model "${KICAD10_3DMODEL_DIR}/Audio_Module.3dshapes/Reverb_BTDR-1H.step"))',
  );
  let status = 404;
  let cancelled = 0;
  let networkFailures = 0;
  let requests = 0;
  const service = createLibraryService({
    root,
    dataDir: root,
    modelFetcher: async (url) => {
      requests++;
      assert.equal(
        String(url),
        'https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/10.0.0/Audio_Module.3dshapes/Reverb_BTDR-1H.step',
      );
      if (networkFailures-- > 0) throw new TypeError('fetch failed');
      return new Response(
        new ReadableStream({
          cancel: () => {
            cancelled++;
          },
        }),
        { status },
      );
    },
  });
  try {
    await assert.rejects(service.model('Audio_Module:Reverb_BTDR-1H', 0), (error: Error) => {
      assert.match(error.message, /Reverb_BTDR-1H\.step.*not available.*KiCad 10\.0\.0/);
      assert.match(error.message, /2D footprint can still be used/);
      assert.doesNotMatch(error.message, /Retry when online/);
      return true;
    });
    const detail = await service.request({
      action: 'detail',
      kind: 'footprints',
      id: 'Audio_Module:Reverb_BTDR-1H',
    });
    assert.deepEqual(detail.pads, ['1']);
    assert.equal(detail.models.length, 1);
    status = 503;
    await assert.rejects(
      service.model('Audio_Module:Reverb_BTDR-1H', 0),
      /download failed \(503\).*Retry/,
    );
    assert.equal(cancelled, 2);
    assert.equal(requests, 2, 'HTTP failures must not be retried as network failures.');

    networkFailures = 2;
    await assert.rejects(service.model('Audio_Module:Reverb_BTDR-1H', 0), (error: Error) => {
      assert.match(error.message, /download failed.*Check your internet connection and retry/);
      assert.match(error.message, /2D footprint can still be used/);
      assert.doesNotMatch(error.message, /fetch failed/);
      return true;
    });
    assert.equal(requests, 4, 'A transport failure gets at most one automatic retry.');

    networkFailures = 1;
    status = 404;
    await assert.rejects(service.model('Audio_Module:Reverb_BTDR-1H', 0), /not available/);
    assert.equal(
      requests,
      6,
      'A recovered connection must retain the actual missing-model result.',
    );
    assert.equal(cancelled, 3);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('official model filenames accept commas while paths and URLs remain rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-path-'));
  // Keep this synthetic model outside the pinned Home subset, which resolves offline.
  const library = 'Test_Commas';
  const name = 'TerminalBlock_Phoenix_PT-1,5-2-3.5-H_1x02_P3.50mm_Horizontal';
  const relative = `${library}.3dshapes/${name}.step`;
  const references = [
    `\${KICAD10_3DMODEL_DIR}/${relative}`,
    `\${KICAD10_3DMODEL_DIR}/${library}.3dshapes/../secret.step`,
    `\${KICAD10_3DMODEL_DIR}/${library}.3dshapes/..\\secret.step`,
    `\${KICAD10_3DMODEL_DIR}/${library}.3dshapes/%2e%2e%2fsecret.step`,
    `\${KICAD10_3DMODEL_DIR}/${library}.3dshapes/secret.step?download=1`,
    'https://example.com/secret.step',
    'C:/private/secret.step',
  ];
  await mkdir(path.join(root, 'symbols'), { recursive: true });
  await mkdir(path.join(root, 'footprints', `${library}.pretty`), { recursive: true });
  await writeFile(
    path.join(root, 'footprints', `${library}.pretty`, `${name}.kicad_mod`),
    writeSExpr([
      'footprint',
      quote(name),
      ['version', '20260206'],
      ...references.map((reference) => ['model', quote(reference)]),
    ]),
  );
  let requests = 0;
  const service = createLibraryService({
    root,
    dataDir: root,
    modelFetcher: async (url, options) => {
      requests++;
      assert.equal(
        String(url),
        `https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/10.0.0/${library}.3dshapes/${name.replace(',', '%2C')}.step`,
      );
      assert.equal(options?.redirect, 'error');
      return new Response(null, { status: 404 });
    },
  });
  try {
    await assert.rejects(service.model(`${library}:${name}`, 0), /not available/);
    for (let index = 1; index < references.length; index++)
      await assert.rejects(
        service.model(`${library}:${name}`, index),
        /supported official STEP path/,
      );
    assert.equal(requests, 1, 'Only a validated official model may reach the network.');
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
