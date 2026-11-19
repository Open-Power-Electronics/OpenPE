import assert from 'node:assert/strict';
import test from 'node:test';
import { LibraryAssetUnavailable } from '../server/library-asset-error.mjs';
import { createNextPcbLibrary } from '../server/nextpcb-library.mjs';
import { createLibraryService } from '../server/libraries.mjs';
import { child, children, propertyValue, val, type LibraryEntry } from '../lib/library';
import { footprintModels } from '../lib/pcb-models';
import { quote } from '../lib/sexpr';

const origin = 'https://library.nextpcb.com';
const symbolUrl = 'https://file.eda.cn/web1/M00/03/F2/vendor.kicad_sym';
const footprintUrl = 'https://file.eda.cn/web1/M00/07/D4/vendor.kicad_mod';
const id = 'NextPCB:9728_LM358';
const symbol = `(kicad_symbol_lib (version 20231120)
  (symbol "VendorPart" (in_bom yes) (on_board yes) (exclude_from_sim no)
    (property "Reference" "U?" (at 0 5 0) (effects (font (size 1.27 1.27))))
    (property "Value" "VendorPart" (at 0 3 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "untrusted:old" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "VendorHidden" "keep-me" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "VendorPart_0_1" (rectangle (start -2.54 -2.54) (end 2.54 2.54)
      (stroke (width 0) (type default)) (fill (type background))))
    (symbol "VendorPart_1_1"
      (pin passive line (at -5.08 0 0) (length 2.54)
        (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 5.08 0 180) (length 2.54)
        (name "OUT" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`;
const footprint = `(footprint "vendor" (version 20240108) (layer "F.Cu")
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
  (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))`;
const row = {
  manufacturer_id: '9728',
  manufacturer: 'MSKSEMI',
  mpn: 'LM358',
  category: 'Operational Amplifiers',
  Description: 'Dual operational amplifier',
  package: 'SOP8',
  footprintFileUrl: footprintUrl,
};
const product = {
  mfgId: 9728,
  mfg: 'MSKSEMI',
  mpn: 'LM358',
  description: 'Dual operational amplifier',
  mfPackageCode: 'SOP8',
  cadUrlList: [
    { type: 'symbol', fileUrl: symbolUrl },
    { type: 'footprint', fileUrl: footprintUrl },
  ],
};
const categoryRows = [
  { cateId: 1737, cateDisplayName: 'Amplifiers', cateName: '放大器', parentId: 0, level: 1 },
  {
    cateId: 1805,
    cateDisplayName: 'Zero Drift Amplifiers',
    cateName: '零漂移放大器',
    parentId: 1737,
    level: 2,
  },
  {
    cateId: 1910,
    cateDisplayName: 'Precision Amplifiers',
    cateName: '精密放大器',
    parentId: 1805,
    level: 3,
  },
  { cateId: 855, cateDisplayName: 'Capacitors', cateName: '电容', parentId: 0, level: 1 },
];
const json = (result: unknown, extra = {}) =>
  new Response(JSON.stringify({ code: 200000, result, ...extra }), {
    headers: { 'Content-Type': 'application/json' },
  });

function fixture(
  respond?: (url: string, options: RequestInit) => Response | Promise<Response> | undefined,
) {
  const calls: { url: string; options: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    const custom = respond?.(url, options);
    if (custom) return custom;
    if (url === `${origin}/api/chiplet/products/kicad/queryPage`) return json([row], { total: 1 });
    if (url === `${origin}/api/chiplet/products/cateTree`) return json(categoryRows);
    if (url === `${origin}/api/chiplet/kicad/productDetail`) return json(product);
    if (url === symbolUrl) return new Response(symbol);
    if (url === footprintUrl) return new Response(footprint);
    throw new Error('Unexpected mock request.');
  };
  return { service: createNextPcbLibrary({ fetcher }), calls, fetcher };
}

test('NextPCB public search uses fixed JSON POST, stable manufacturer identities and bounded pages', async () => {
  const { service, calls } = fixture((url, options) => {
    if (!url.endsWith('/queryPage')) return;
    const body = JSON.parse(String(options.body));
    assert.deepEqual(body, {
      pageNum: 3,
      pageSize: 50,
      haveEdaModel: 1,
      have3dModel: 0,
      haveSimModel: 0,
      haveSupplierModel: 0,
      desc: 'LM/358&x=1',
    });
    return json(
      [
        { ...row, mpn: 'LM/358&x=1' },
        { ...row, manufacturer_id: '9769' },
      ],
      { total: 102 },
    );
  });
  try {
    const query = {
      action: 'search',
      kind: 'symbols',
      library: 'NextPCB',
      query: ' LM/358&x=1 ',
      offset: 100,
    };
    const result = await service.request(query);
    assert.equal(result.total, 102);
    assert.deepEqual(result.libraries, ['NextPCB']);
    assert.equal(result.entries[0].id, 'NextPCB:9728_LM%2F358%26x%3D1');
    assert.equal(result.entries[1].id, 'NextPCB:9769_LM358');
    assert.equal(result.entries[0].footprint, result.entries[0].id);
    assert.equal(result.entries[0].manufacturer, 'MSKSEMI');
    assert.equal(result.entries[0].package, 'SOP8');
    assert.equal(calls.length, 1);
    result.entries[0].name = 'mutated';
    assert.equal((await service.request(query)).entries[0].name, 'LM/358&x=1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(calls[0].options.method, 'POST');
  } finally {
    service.close();
  }
});

test('NextPCB matches declared packages across category pages while preserving raw offsets', async () => {
  const { fetcher, calls } = fixture((url, options) => {
    if (!url.endsWith('/queryPage')) return;
    const body = JSON.parse(String(options.body));
    if (!body.cateId) {
      assert.equal(body.desc, 'SOP8');
      return json([row, { ...row, mpn: 'SOP8-Comparison', package: 'DIP8' }], { total: 2 });
    }
    assert.equal(body.cateId, 1737);
    assert.equal(body.desc, undefined, 'Category scanning matches package-only rows.');
    const other = Array.from({ length: 49 }, (_, index) => ({
      ...row,
      mpn: 'Other-' + index,
      package: index % 2 ? 'DIP8' : '',
    }));
    return body.pageNum === 1
      ? json([...other, row], { total: 51 })
      : json([{ ...row, mpn: 'Other-50', package: 'DIP8' }], { total: 51 });
  });
  const service = createLibraryService({ nextpcbFetcher: fetcher });
  const search = { action: 'search', kind: 'symbols', library: 'NextPCB', includeAssetStatus: true };
  try {
    const first = await service.request({ ...search, query: ' package:sop-8 ', category: '1737' });
    assert.deepEqual(first.entries.map(({ id }: LibraryEntry) => id), [id]);
    assert.equal(first.entries[0].footprintPreview, '2d');
    assert.equal(first.nextOffset, 50);
    const next = await service.request({
      ...search,
      query: 'package:sop-8',
      category: '1737',
      offset: first.nextOffset,
    });
    assert.deepEqual(next.entries, []);
    assert.equal(next.nextOffset, null);
    const all = await service.request({ ...search, query: 'package:SOP8' });
    assert.deepEqual(all.entries.map(({ id }: LibraryEntry) => id), [id]);
    assert.deepEqual(await service.request({ ...search, query: 'SOP8' }), all);
    assert.equal(calls.filter(({ url }) => url.endsWith('/queryPage')).length, 3);
    assert.equal(calls.filter(({ url }) => url.endsWith('/productDetail')).length, 1);
  } finally {
    service.close();
  }
});

test('NextPCB finds bare 0603 in All categories by matching catalog package fields', async () => {
  const resistor = { ...row, mpn: 'Chip-R', package: '0603' };
  const capacitor = { ...row, mpn: 'Chip-C', package: 'C0603 (1608 Metric)' };
  const { service, calls } = fixture((url, options) => {
    if (url.endsWith('/cateTree'))
      return json([
        ...categoryRows,
        { cateId: 865, cateDisplayName: 'Resistors', parentId: 0, level: 1 },
        { cateId: 1009, cateDisplayName: 'Chip Resistors', parentId: 865, level: 2 },
        { cateId: 398, cateDisplayName: 'Chip Capacitor (MLCC)', parentId: 855, level: 2 },
      ]);
    assert.ok(url.endsWith('/queryPage'), 'Search reads metadata only.');
    const body = JSON.parse(String(options.body));
    assert.equal(body.desc, undefined, 'Bare package codes use category pages.');
    assert.equal(body.pageNum, 1);
    if (body.cateId === 1009)
      return json(
        [
          { ...row, mpn: 'Chip-0201', package: '0201 (0603 Metric)' },
          { ...row, mpn: 'Looks-like-0603', package: '0805' },
          resistor,
        ],
        { total: 500 },
      );
    assert.equal(body.cateId, 398);
    return json([resistor, capacitor], { total: 500 });
  });
  const search = { action: 'search', kind: 'symbols', library: 'NextPCB', query: ' 0603 ' };
  try {
    const first = await service.request({ ...search, scanLimit: 1 });
    assert.deepEqual(first.entries.map(({ name }: LibraryEntry) => name), ['Chip-R']);
    assert.equal(first.total, 2);
    assert.equal(first.nextOffset, 1);
    const second = await service.request({ ...search, offset: first.nextOffset, scanLimit: 1 });
    assert.deepEqual(second.entries.map(({ name }: LibraryEntry) => name), ['Chip-C']);
    assert.equal(second.nextOffset, null);
    assert.deepEqual(await service.request({ ...search, query: 'package:0603', scanLimit: 1 }), first);
    assert.equal(calls.length, 3, 'Pagination and equivalent queries reuse catalog pages.');
    const selected = await service.request({ ...search, category: '1009' });
    assert.deepEqual(selected.entries.map(({ name }: LibraryEntry) => name), ['Chip-R']);
    assert.equal(selected.nextOffset, 50);
  } finally {
    service.close();
  }
});

test('NextPCB uses the verified suggestion category for blank All searches', async () => {
  const { service, calls } = fixture((url, options) => {
    if (!url.endsWith('/queryPage')) return;
    const { cateId, desc } = JSON.parse(String(options.body));
    if (!desc && !cateId) return Response.json({ code: 50000, message: '参数不能为空' });
  });
  try {
    const all = await service.request({ action: 'search', kind: 'symbols', query: '   ' });
    assert.equal(all.entries[0].id, id);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith('/cateTree'));
    assert.ok(calls[1].url.endsWith('/queryPage'));
    const suggestions = JSON.parse(String(calls[1].options.body));
    assert.equal(suggestions.cateId, 1737);
    assert.equal(Object.hasOwn(suggestions, 'desc'), false);
    const result = await service.request({
      action: 'search',
      kind: 'symbols',
      query: '',
      category: '1737',
    });
    assert.equal(result.entries[0].id, id);
    assert.equal(calls.length, 2, 'Suggestions and the same explicit category share a page.');
    await service.request({ action: 'search', kind: 'symbols', query: 'LM358' });
    const keyword = JSON.parse(String(calls[2].options.body));
    assert.equal(keyword.desc, 'LM358');
    assert.equal(Object.hasOwn(keyword, 'cateId'), false);
  } finally {
    service.close();
  }
});

test('NextPCB leaves a missing suggestion category retryable and still permits keyword search', async () => {
  const { service, calls } = fixture((url) => {
    if (url.endsWith('/cateTree')) return json([categoryRows.at(-1)]);
  });
  try {
    const browse = { action: 'search', kind: 'symbols' };
    await assert.rejects(service.request(browse), /NextPCB suggestions are unavailable/);
    assert.ok(calls.every(({ url }) => url.endsWith('/cateTree')));
    assert.equal((await service.request({ ...browse, query: 'LM358' })).entries[0].id, id);
  } finally {
    service.close();
  }
});

test('NextPCB keeps symbol candidates without a footprint and shares raw paging with the footprint chooser', async () => {
  const { service, calls } = fixture((url, options) => {
    if (!url.endsWith('/queryPage')) return;
    const { pageNum } = JSON.parse(String(options.body));
    if (pageNum === 2) return json([{ ...row, mpn: 'Other model' }], { total: 51 });
    return json(
      [
        { ...row, mpn: 'No CAD', footprintFileUrl: null },
        { ...row, mpn: 'Foreign CAD', footprintFileUrl: 'https://example.org/foreign.kicad_mod' },
        row,
      ],
      { total: 51 },
    );
  });
  try {
    const search = { action: 'search', kind: 'symbols', query: 'LM358' };
    const first = await service.request(search);
    assert.deepEqual(
      first.entries.map((entry: { id: string }) => entry.id),
      ['NextPCB:9728_No%20CAD', 'NextPCB:9728_Foreign%20CAD', id],
    );
    assert.equal(first.entries[0].footprint, undefined);
    assert.equal(first.entries[1].footprint, undefined);
    assert.equal(first.nextOffset, 50);
    assert.deepEqual(await service.request({ ...search, kind: 'footprints' }), {
      ...first,
      entries: [first.entries[2]],
    });
    assert.equal(calls.length, 1, 'Both kinds share the catalog without downloading native files.');
    const second = await service.request({ ...search, offset: first.nextOffset });
    assert.equal(second.entries[0].name, 'Other model');
    assert.equal(second.nextOffset, null);
  } finally {
    service.close();
  }
});

test('NextPCB checked batches span native pages without shifting the raw cursor', async () => {
  const {
    calls,
    fetcher,
    service: adapter,
  } = fixture((url, options) => {
    if (url.endsWith('/queryPage')) {
      const { pageNum, pageSize } = JSON.parse(String(options.body));
      const start = (pageNum - 1) * pageSize;
      const rows = Array.from({ length: Math.min(pageSize, 70 - start) }, (_, index) => {
        const cursor = start + index;
        return {
          ...row,
          mpn: `Part_${cursor}`,
          footprintFileUrl: cursor === 64 ? null : footprintUrl,
        };
      });
      return json(rows, { total: 70 });
    }
    if (url.endsWith('/productDetail')) {
      const { mpn } = JSON.parse(String(options.body));
      return json({
        ...product,
        mpn,
        ...(mpn === 'Part_64' ? { cadUrlList: [{ type: 'symbol', fileUrl: symbolUrl }] } : {}),
      });
    }
  });
  const libraries = createLibraryService({ nextpcbFetcher: fetcher });
  try {
    const search = {
      action: 'search',
      kind: 'symbols',
      library: 'NextPCB',
      query: 'Part',
      includeAssetStatus: true,
    };
    const first = await libraries.request({ ...search, offset: 47 });
    assert.equal(first.nextOffset, 63);
    assert.deepEqual(
      first.entries.map((entry: LibraryEntry) => entry.name),
      Array.from({ length: 16 }, (_, index) => `Part_${47 + index}`),
    );
    assert.ok(first.entries.every((entry: LibraryEntry) => entry.footprintPreview === '2d'));
    const last = await libraries.request({ ...search, offset: first.nextOffset });
    assert.equal(last.nextOffset, null);
    assert.deepEqual(
      last.entries.map((entry: LibraryEntry) => entry.name),
      ['Part_63', 'Part_64', 'Part_65', 'Part_66', 'Part_67', 'Part_68', 'Part_69'],
    );
    assert.equal(last.entries[1].footprintPreview, 'unavailable');
    assert.equal(last.entries[1].footprint, undefined);
    assert.equal(calls.filter(({ url }) => url.endsWith('/queryPage')).length, 2);
    assert.equal(calls.filter(({ url }) => url.endsWith('/productDetail')).length, 23);
  } finally {
    libraries.close();
    adapter.close();
  }
});

test('NextPCB categories retain native English hierarchy and category-filtered pages stay independent', async () => {
  const { service, calls } = fixture();
  try {
    const catalog = await service.request({ action: 'categories', kind: 'symbols' });
    assert.deepEqual(catalog, {
      categories: [
        {
          id: '1737',
          name: 'Amplifiers',
          children: [
            {
              id: '1805',
              name: 'Zero Drift Amplifiers',
              children: [{ id: '1910', name: 'Precision Amplifiers', children: [] }],
            },
          ],
        },
        { id: '855', name: 'Capacitors', children: [] },
      ],
    });
    assert.deepEqual(JSON.parse(String(calls[0].options.body)), {});
    catalog.categories[0].children[0].name = 'caller mutation';
    assert.equal(
      (await service.request({ action: 'categories', kind: 'footprints' })).categories[0]
        .children[0].name,
      'Zero Drift Amplifiers',
    );
    assert.equal(calls.length, 1, 'The two chooser kinds share one public category tree.');
    const query = { action: 'search', kind: 'symbols', library: 'NextPCB', query: 'LM358' };
    for (const category of ['1737', '1805', '1910', ''])
      await service.request({ ...query, category });
    const searchBodies = calls
      .filter((call) => call.url.endsWith('/queryPage'))
      .map((call) => JSON.parse(String(call.options.body)));
    assert.deepEqual(
      searchBodies.map((body) => body.cateId),
      [1737, 1805, 1910, undefined],
    );
    await service.request({ ...query, category: '1910' });
    assert.equal(calls.length, 5);
    await assert.rejects(
      service.request({ ...query, category: '9999' }),
      /available NextPCB category/,
    );
    await assert.rejects(
      service.request({ ...query, category: '01805' }),
      /Invalid NextPCB search/,
    );
    await assert.rejects(
      service.request({ ...query, category: 'https://foreign.example' }),
      /Invalid NextPCB search/,
    );
    assert.equal(calls.length, 5, 'Unknown IDs never reach the product search endpoint.');
  } finally {
    service.close();
  }
});

test('NextPCB category catalogs reject malformed hierarchies, remain retryable and never invent orphan parents', async () => {
  const badTrees = [
    [...categoryRows, categoryRows[0]],
    [
      { cateId: 1, cateDisplayName: 'A', parentId: 2, level: 1 },
      { cateId: 2, cateDisplayName: 'B', parentId: 1, level: 2 },
    ],
    [{ ...categoryRows[0], cateDisplayName: '' }],
    [{ ...categoryRows[0], cateId: '1737' }],
    [{ ...categoryRows[0], level: 9 }],
    [categoryRows[0], { ...categoryRows[1], level: 3 }],
    Array.from({ length: 2001 }, (_, index) => ({ ...categoryRows[0], cateId: index + 1 })),
  ];
  for (const bad of badTrees) {
    let first = true;
    const { service, calls } = fixture((url) => {
      if (!url.endsWith('/cateTree')) return;
      const result = first ? bad : categoryRows;
      first = false;
      return json(result);
    });
    try {
      await assert.rejects(service.request({ action: 'categories', kind: 'symbols' }), /categor/);
      assert.equal(
        (await service.request({ action: 'categories', kind: 'symbols' })).categories.length,
        2,
      );
      assert.equal(calls.length, 2, 'Invalid catalogs never poison a retry.');
    } finally {
      service.close();
    }
  }
  const { service } = fixture((url) =>
    url.endsWith('/cateTree')
      ? json([
          ...categoryRows,
          { cateId: 2000, cateDisplayName: 'Orphan', parentId: 9999, level: 3 },
          { cateId: 2001, cateDisplayName: 'Orphan Child', parentId: 2000, level: 4 },
        ])
      : undefined,
  );
  try {
    assert.equal(
      (await service.request({ action: 'categories', kind: 'symbols' })).categories.length,
      2,
    );
    await assert.rejects(
      service.request({ action: 'search', kind: 'symbols', category: '2001' }),
      /available NextPCB category/,
    );
  } finally {
    service.close();
  }
});

test('NextPCB category cancellation rejects cached responses and shutdown releases its catalog', async () => {
  const { service, calls } = fixture();
  await service.request({ action: 'categories', kind: 'symbols' });
  const control = new AbortController();
  const pending = service.request({
    action: 'categories',
    kind: 'symbols',
    signal: control.signal,
  });
  control.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls.length, 1);
  service.close();
  await assert.rejects(service.request({ action: 'categories', kind: 'symbols' }), /closed/);
});

test('NextPCB native symbol detail prepares its linked package before placement and retains hidden fields', async () => {
  const { service, calls } = fixture();
  try {
    const result = await service.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(result.id, id);
    assert.equal(result.name, 'LM358');
    assert.equal(result.manufacturer, 'MSKSEMI');
    assert.equal(result.package, 'SOP8');
    assert.equal(result.units, 1);
    assert.equal(val(result.symbol), id);
    assert.equal(propertyValue(result.symbol, 'Value'), 'LM358');
    assert.equal(propertyValue(result.symbol, 'Reference'), 'U');
    assert.equal(propertyValue(result.symbol, 'Footprint'), id);
    assert.equal(propertyValue(result.symbol, 'VendorHidden'), 'keep-me');
    assert.equal(children(result.symbol, 'symbol').length, 2);
    assert.deepEqual(
      children(result.symbol, 'symbol').map((unit) => val(unit)),
      ['9728_LM358_0_1', '9728_LM358_1_1'],
    );
    assert.ok(calls.some((call) => call.url === footprintUrl));
    assert.deepEqual(JSON.parse(String(calls[0].options.body)), {
      manufacturer_id: '9728',
      mpn: 'LM358',
    });
    const packageDetail = await service.request({ action: 'detail', kind: 'footprints', id });
    assert.deepEqual(packageDetail.pads, ['1', '2']);
    assert.deepEqual(packageDetail.models, []);
    assert.equal(val(packageDetail.footprint), id.slice('NextPCB:'.length));
    assert.equal(calls.filter((call) => call.url === footprintUrl).length, 1);
    result.symbol[1] = '"changed"';
    assert.equal(
      val((await service.request({ action: 'detail', kind: 'symbols', id })).symbol),
      id,
    );
    assert.equal(child(packageDetail.footprint, 'version')?.[1], '20240108');
  } finally {
    service.close();
  }
});

test('NextPCB resolves scheme-relative native links and preserves filenames on the supported CDN', async () => {
  const symbolLink = '//file.eda.cn/web2/M00/03/F2/元件 Rev.2.kicad_sym';
  const footprintLink = '//file.eda.cn/web2/M00/07/D4/Package%20(Rev.2).kicad_mod';
  const canonicalSymbol = 'https://file.eda.cn/web2/M00/03/F2/%E5%85%83%E4%BB%B6%20Rev.2.kicad_sym';
  const canonicalFootprint = `https:${footprintLink}`;
  const { service, calls } = fixture((url) => {
    if (url.endsWith('/queryPage'))
      return json([{ ...row, footprintFileUrl: footprintLink }], { total: 1 });
    if (url.endsWith('/productDetail'))
      return json({
        ...product,
        cadUrlList: [
          { type: 'symbol', fileUrl: symbolLink },
          { type: 'footprint', fileUrl: footprintLink },
        ],
      });
    if (url === canonicalSymbol) return new Response(symbol);
    if (url === canonicalFootprint) return new Response(footprint);
  });
  try {
    const results = await service.request({ action: 'search', kind: 'symbols', query: 'LM358' });
    assert.deepEqual(
      results.entries.map((entry: LibraryEntry) => entry.id),
      [id],
    );
    const result = await service.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(result.footprintPreview, '2d');
    assert.equal(result.warning, undefined);
    assert.deepEqual(
      calls.slice(2).map(({ url }) => url),
      [canonicalSymbol, canonicalFootprint],
    );
  } finally {
    service.close();
  }
});

test('NextPCB preserves valid symbols with a rejected footprint source and retries corrected links', async () => {
  const rejectedFootprint = 'https://example.com/web1/M00/vendor.kicad_mod';
  let repaired = false;
  const { service, calls } = fixture((url) =>
    url.endsWith('/productDetail') && !repaired
      ? json({
          ...product,
          cadUrlList: [product.cadUrlList[0], { type: 'footprint', fileUrl: rejectedFootprint }],
        })
      : undefined,
  );
  try {
    const result = await service.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(propertyValue(result.symbol, 'Footprint'), id);
    assert.equal(result.footprintPreview, 'unavailable');
    assert.match(result.warning, /^Footprint unavailable: .*HTTPS source/);
    assert.equal(JSON.stringify(result).includes(rejectedFootprint), false);
    await assert.rejects(
      service.request({ action: 'detail', kind: 'footprints', id }),
      (error) => error instanceof LibraryAssetUnavailable && /HTTPS source/.test(error.message),
    );
    assert.equal(
      calls.some(({ url }) => url === rejectedFootprint),
      false,
    );

    repaired = true;
    const updated = await service.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(updated.footprintPreview, '2d');
    assert.equal(updated.warning, undefined);
    assert.ok(calls.some(({ url }) => url === footprintUrl));
  } finally {
    service.close();
  }
});

test('NextPCB starts both native reads together and a failed footprint retains its valid schematic symbol', async () => {
  for (const footprintStatus of [200, 404, 503]) {
    const releases = new Map<string, (response: Response) => void>();
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const { service } = fixture((url) => {
      if (![symbolUrl, footprintUrl].includes(url)) return;
      return new Promise<Response>((resolve) => {
        releases.set(url, resolve);
        if (releases.size === 2) bothStarted();
      });
    });
    const pending = service.request({ action: 'detail', kind: 'symbols', id });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Both native reads must start before either is released.')),
            1000,
          );
        }),
      ]);
      assert.deepEqual([...releases.keys()], [symbolUrl, footprintUrl]);
      releases.get(footprintUrl)!(
        footprintStatus === 200
          ? new Response(footprint)
          : new Response(null, { status: footprintStatus }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      releases.get(symbolUrl)!(new Response(symbol));
      const result = await pending;
      assert.equal(propertyValue(result.symbol, 'Footprint'), id);
      if (footprintStatus !== 200) {
        assert.ok(result.warning?.includes(`NextPCB request failed (${footprintStatus})`));
        assert.equal(result.footprintPreview, footprintStatus === 404 ? 'unavailable' : undefined);
      } else {
        assert.equal(result.warning, undefined);
        assert.equal(result.footprintPreview, '2d');
        assert.deepEqual(
          (await service.request({ action: 'detail', kind: 'footprints', id })).pads,
          ['1', '2'],
        );
      }
    } finally {
      clearTimeout(timer);
      service.close();
      for (const release of releases.values()) release(new Response(null, { status: 499 }));
      await pending.catch(() => {});
    }
  }
});

test('NextPCB validates standalone footprints even when the supplier has no usable symbol', async () => {
  for (const brokenSymbol of [null, 'https://example.org/vendor.kicad_sym', symbolUrl]) {
    const { service, calls } = fixture((url) => {
      if (url.endsWith('/productDetail'))
        return json({
          ...product,
          cadUrlList: [
            { type: 'footprint', fileUrl: footprintUrl },
            ...(brokenSymbol ? [{ type: 'symbol', fileUrl: brokenSymbol }] : []),
          ],
        });
      if (url === symbolUrl) return new Response('Invalid native symbol');
    });
    try {
      const detail = await service.request({ action: 'detail', kind: 'footprints', id });
      assert.deepEqual(detail.pads, ['1', '2']);
      assert.equal(detail.id, id);
      assert.deepEqual(
        calls.map(({ url }) => url),
        [`${origin}/api/chiplet/kicad/productDetail`, footprintUrl],
      );
      await assert.rejects(service.request({ action: 'detail', kind: 'symbols', id }));
    } finally {
      service.close();
    }
  }
});

test('NextPCB display metadata stays optional and is never inferred from keyword or description text', async () => {
  const { service } = fixture((url) => {
    if (url.endsWith('/queryPage'))
      return json(
        [
          {
            ...row,
            manufacturer: null,
            package: null,
            Description: 'MSKSEMI manufacturer SOP8 package',
          },
        ],
        { total: 1 },
      );
    if (url.endsWith('/productDetail')) return json({ ...product, mfg: null, mfPackageCode: null });
  });
  try {
    const search = await service.request({ action: 'search', kind: 'symbols', query: 'LM358' });
    const detail = await service.request({ action: 'detail', kind: 'symbols', id });
    for (const entry of [search.entries[0], detail]) {
      assert.equal(Object.hasOwn(entry, 'manufacturer'), false);
      assert.equal(Object.hasOwn(entry, 'package'), false);
    }
  } finally {
    service.close();
  }
});

test('NextPCB accepts multiline descriptions without losing other catalog results or relaxing identity checks', async () => {
  const description = 'Digital microphone\r\nSupply voltage:\t1.8 V';
  let mpn = row.mpn;
  const { service } = fixture((url) => {
    if (url.endsWith('/queryPage'))
      return json(
        [
          { ...row, mpn, Description: description },
          { ...row, manufacturer_id: '9769' },
        ],
        { total: 2 },
      );
    if (url.endsWith('/productDetail')) return json({ ...product, description });
  });
  try {
    const request = { action: 'search', kind: 'symbols', query: 'LM358' };
    const { entries } = await service.request(request);
    assert.deepEqual(
      entries.map(({ id }: LibraryEntry) => id),
      [id, 'NextPCB:9769_LM358'],
    );
    const detail = await service.request({ action: 'detail', kind: 'symbols', id });
    for (const entry of [entries[0], detail])
      assert.equal(entry.description, 'Digital microphone Supply voltage: 1.8 V');
    mpn = 'LM\n358';
    await assert.rejects(
      service.request({ ...request, query: 'LM' }),
      /invalid component metadata/,
    );
  } finally {
    service.close();
  }
});

test('NextPCB rejects caller URLs, noncanonical identities and invalid search requests without network access', async () => {
  const { service, calls } = fixture();
  try {
    for (const invalid of [
      'https://example.com/a',
      'NextPCB:0_LM358',
      'NextPCB:9728_%4cM358',
      'NextPCB:9728_%00',
      'NextPCB:9728_%ZZ',
    ])
      await assert.rejects(
        service.request({ action: 'detail', kind: 'symbols', id: invalid }),
        /identity/,
      );
    for (const invalid of [
      { query: 'x'.repeat(201) },
      { offset: -1 },
      { offset: 0.5 },
      { library: 'foreign' },
    ])
      await assert.rejects(
        service.request({ action: 'search', kind: 'symbols', query: 'LM358', ...invalid }),
        /search/,
      );
    assert.equal(calls.length, 0);
  } finally {
    service.close();
  }
});

test('NextPCB rejects asset redirects, foreign origins, path escapes and wrong file formats', async () => {
  for (const fileUrl of [
    'http://file.eda.cn/web1/M00/native.kicad_sym',
    'https://file.eda.cn.evil.test/web1/M00/native.kicad_sym',
    '//example.com/web1/M00/native.kicad_sym',
    'https://user:pass@file.eda.cn/web1/M00/native.kicad_sym',
    'https://file.eda.cn:443/web1/M00/native.kicad_sym',
    'https://file.eda.cn:444/web1/M00/native.kicad_sym',
    'https://file.eda.cn/web1/M00/native.kicad_sym?url=http://127.0.0.1',
    'https://file.eda.cn/web1/M00/native.kicad_sym#download',
    'https://file.eda.cn/web1/M00/%2e%2e/native.kicad_sym',
    'https://file.eda.cn/web1/M00/a%2Fnative.kicad_sym',
    'https://file.eda.cn/web1/M00/a%252Fnative.kicad_sym',
    'https://file.eda.cn/web1/M00/a%23native.kicad_sym',
    'https://file.eda.cn/web1/M00/native.zip',
  ]) {
    const { service, calls } = fixture((url) =>
      url.endsWith('/productDetail')
        ? json({ ...product, cadUrlList: [{ type: 'symbol', fileUrl }] })
        : undefined,
    );
    try {
      await assert.rejects(
        service.request({ action: 'detail', kind: 'symbols', id }),
        /HTTPS source/,
      );
      assert.equal(calls.length, 1, 'Invalid assets must not be fetched.');
    } finally {
      service.close();
    }
  }
  const { service } = fixture(
    () => new Response(null, { status: 302, headers: { Location: 'https://example.com' } }),
  );
  try {
    await assert.rejects(
      service.request({ action: 'search', kind: 'symbols', query: 'LM358' }),
      /request failed \(302\)/,
    );
  } finally {
    service.close();
  }
});

test('NextPCB validates response identity and syntax and leaves download failures retryable', async () => {
  let attempts = 0;
  const { service } = fixture((url) => {
    if (url !== symbolUrl) return;
    attempts++;
    return attempts === 1
      ? new Response('<html>temporary upstream error</html>')
      : new Response(symbol);
  });
  try {
    await assert.rejects(
      service.request({ action: 'detail', kind: 'symbols', id }),
      /S-expression/,
    );
    assert.equal((await service.request({ action: 'detail', kind: 'symbols', id })).id, id);
    assert.equal(attempts, 2);
  } finally {
    service.close();
  }
  for (const response of [
    json({ ...product, mpn: 'different' }),
    new Response('not json'),
    json(null),
  ]) {
    const { service: invalid } = fixture(() => response);
    try {
      await assert.rejects(
        invalid.request({ action: 'detail', kind: 'symbols', id }),
        /invalid|different/,
      );
    } finally {
      invalid.close();
    }
  }
});

test('NextPCB catalog rejection reports its business code without misdiagnosing an offline connection', async () => {
  const responses = [
    {
      value: { code: 50000, message: 'Do not forward arbitrary provider diagnostics.' },
      error: /^Error: NextPCB rejected the catalog request \(code 50000\)\.$/,
    },
    {
      value: { code: '50000', result: [] },
      error: /^Error: NextPCB returned an invalid catalog response\.$/,
    },
    {
      value: { code: 200000 },
      error: /^Error: NextPCB returned an invalid catalog response\.$/,
    },
  ];
  for (const { value, error } of responses) {
    let attempts = 0;
    const { service } = fixture((url) => {
      if (!url.endsWith('/queryPage') || attempts++ > 0) return;
      return Response.json(value);
    });
    try {
      await assert.rejects(
        service.request({ action: 'search', kind: 'symbols', query: 'LM358' }),
        error,
      );
      assert.equal(
        (await service.request({ action: 'search', kind: 'symbols', query: 'LM358' })).total,
        1,
        'Rejected responses never poison a later valid retry.',
      );
    } finally {
      service.close();
    }
  }
});

test('NextPCB official model references retain their native path and pose without downloading models during catalog reads', async () => {
  for (const reference of [
    '${KICAD6_3DMODEL_DIR}/Diode_THT.3dshapes/D_DO-35_SOD27_P7.62mm_Horizontal.wrl',
    '${KICAD8_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step',
    '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step',
  ]) {
    const pose = '(offset (xyz 1.25 -2.5 3)) (scale (xyz 0.5 2 1)) (rotate (xyz 45 0 -90))';
    const { service, calls } = fixture((url) =>
      url === footprintUrl
        ? new Response(
            footprint.replace(
              /\)$/,
              ` (model ${quote(reference)} ${pose} (hide yes) (opacity 0.4)))`,
            ),
          )
        : undefined,
    );
    try {
      const result = await service.request({ action: 'detail', kind: 'symbols', id });
      assert.equal(result.warning, undefined);
      assert.equal(propertyValue(result.symbol, 'Footprint'), id);
      const detail = await service.request({ action: 'detail', kind: 'footprints', id });
      assert.deepEqual(detail.models, [
        {
          path: reference,
          offset: ['offset', ['xyz', '1.25', '-2.5', '3']],
          scale: ['scale', ['xyz', '0.5', '2', '1']],
          rotate: ['rotate', ['xyz', '45', '0', '-90']],
        },
      ]);
      assert.deepEqual(footprintModels(detail.footprint), [
        {
          path: reference,
          offset: { x: 1.25, y: -2.5, z: 3 },
          scale: { x: 0.5, y: 2, z: 1 },
          rotation: { x: 45, y: 0, z: -90 },
          hidden: true,
          opacity: 0.4,
        },
      ]);
      assert.deepEqual(
        calls.map((call) => call.url),
        [`${origin}/api/chiplet/kicad/productDetail`, symbolUrl, footprintUrl],
      );
      detail.models[0].offset[1][1] = '999';
      assert.equal(
        (await service.request({ action: 'detail', kind: 'footprints', id })).models[0]
          .offset[1][1],
        '1.25',
      );
    } finally {
      service.close();
    }
  }
});

test('NextPCB converts the documented inch-based model pose in supported vendor footprints', async () => {
  const reference = '${KICAD6_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.wrl';
  const packageWith = (version: string, pose: string) =>
    footprint.replace('20240108', version).replace(/\)$/, ` (model ${quote(reference)} ${pose}))`);
  let native = packageWith('20210108', '(at (xyz 0.05 -0.1 0.2)) (rotate (xyz 0 0 90))');
  const { service } = fixture((url) => (url === footprintUrl ? new Response(native) : undefined));
  try {
    const detail = await service.request({ action: 'detail', kind: 'footprints', id });
    assert.deepEqual(detail.models[0].offset, ['offset', ['xyz', '1.27', '-2.54', '5.08']]);
    assert.deepEqual(footprintModels(detail.footprint)[0].offset, { x: 1.27, y: -2.54, z: 5.08 });
    assert.equal(child(child(detail.footprint, 'model')!, 'at'), undefined);
  } finally {
    service.close();
  }
  for (const file of [
    packageWith('20210108', '(at (xyz 0 0 0)) (offset (xyz 0 0 0))'),
    packageWith('20210108', '(at (xyz 0 0 0)) (at (xyz 0 0 0))'),
    packageWith('20210108', '(at (xyz 0.00000001 0 0))'),
    packageWith('20210108', '(at (xyz Infinity 0 0))'),
    packageWith('20240108', '(at (xyz 0 0 0))'),
  ]) {
    native = file;
    const { service } = fixture((url) => (url === footprintUrl ? new Response(native) : undefined));
    try {
      await assert.rejects(
        service.request({ action: 'detail', kind: 'footprints', id }),
        /NextPCB 3D model offset/,
      );
    } finally {
      service.close();
    }
  }
});

test('NextPCB foreign and malformed model paths warn on symbols and reject package detail without fetching those paths', async () => {
  for (const reference of [
    '/private/foreign.step',
    'C:/private/foreign.step',
    'file:///private/foreign.step',
    'https://example.com/foreign.step',
    '${KIPRJMOD}/models/foreign.step',
    '${KICAD10_3DMODEL_DIR}/../foreign.step',
    '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/../../foreign.step',
    '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/nested/foreign.step',
    '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/foreign.step?source=http://127.0.0.1',
    '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/foreign.wrl#part',
    '${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/foreign.obj',
  ]) {
    const { service, calls } = fixture((url) =>
      url === footprintUrl
        ? new Response(footprint.replace(/\)$/, ` (model ${quote(reference)}))`))
        : undefined,
    );
    try {
      const result = await service.request({ action: 'detail', kind: 'symbols', id });
      assert.match(result.warning, /supported KiCad 3D library/);
      assert.equal(propertyValue(result.symbol, 'Footprint'), id);
      await assert.rejects(
        service.request({ action: 'detail', kind: 'footprints', id }),
        /supported KiCad 3D library/,
      );
      assert.ok(
        calls.every((call) =>
          [`${origin}/api/chiplet/kicad/productDetail`, symbolUrl, footprintUrl].includes(call.url),
        ),
        'A native model path grants neither local file access nor an arbitrary network request.',
      );
    } finally {
      service.close();
    }
  }
});

test('NextPCB STEP adoption returns exact bytes only for one provider asset and one validated native model', async () => {
  const modelUrl = 'https://file.eda.cn/web1/M00/05/6B/provider.step';
  const bytes = Buffer.from('ISO-10303-21;\nDATA;\n', 'utf8');
  const binary = Buffer.concat([bytes, Buffer.from([255, 0, 128])]);
  const { service, calls } = fixture((url) => {
    if (url.endsWith('/productDetail'))
      return json({
        ...product,
        cadUrlList: [...product.cadUrlList, { type: '3d', fileUrl: modelUrl }],
      });
    if (url === footprintUrl)
      return new Response(
        footprint.replace(/\)$/, ' (model "${KICAD6_3DMODEL_DIR}/Diode_THT.3dshapes/D_DO35.wrl"))'),
      );
    if (url === modelUrl) return new Response(binary);
  });
  try {
    assert.equal(
      (await service.request({ action: 'detail', kind: 'symbols', id })).warning,
      undefined,
    );
    assert.equal(
      calls.some((c) => c.url === modelUrl),
      false,
    );
    assert.deepEqual(await service.modelBytes(id, 0), binary);
    assert.equal(calls.filter((c) => c.url === modelUrl).length, 1);
    assert.equal(calls.find((c) => c.url === modelUrl)?.options.credentials, 'omit');
    assert.equal(calls.find((c) => c.url === modelUrl)?.options.redirect, 'error');
  } finally {
    service.close();
  }
});

test('NextPCB absent STEP assets stay absent and ambiguous assets or native poses cannot be guessed', async () => {
  const { service } = fixture();
  try {
    assert.equal(await service.modelBytes(id, 0), undefined);
    for (const index of [-1, 32, 0.5]) await assert.rejects(service.modelBytes(id, index), /index/);
  } finally {
    service.close();
  }
  for (const models of [0, 2]) {
    const { service, calls } = fixture((url) => {
      if (url.endsWith('/productDetail'))
        return json({
          ...product,
          cadUrlList: [
            ...product.cadUrlList,
            { type: '3d', fileUrl: 'https://file.eda.cn/web1/M00/test.step' },
          ],
        });
      if (url === footprintUrl)
        return new Response(
          footprint.replace(
            /\)$/,
            ' (model "${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step")'.repeat(models) +
              ')',
          ),
        );
    });
    try {
      await assert.rejects(service.modelBytes(id, 0), /exactly one native/);
      assert.equal(
        calls.some((c) => c.url.endsWith('.step')),
        false,
      );
    } finally {
      service.close();
    }
  }
  const { service: ambiguous } = fixture((url) =>
    url.endsWith('/productDetail')
      ? json({
          ...product,
          cadUrlList: [
            ...product.cadUrlList,
            { type: '3d', fileUrl: 'https://file.eda.cn/web1/M00/a.step' },
            { type: '3d', fileUrl: 'https://file.eda.cn/web1/M00/b.step' },
          ],
        })
      : undefined,
  );
  try {
    await assert.rejects(ambiguous.modelBytes(id, 0), /ambiguous 3D assets/);
  } finally {
    ambiguous.close();
  }
});

test('NextPCB provider STEP URL validation rejects foreign paths and never exposes URLs in public details', async () => {
  for (const url of [
    'http://file.eda.cn/web1/M00/a.step',
    'https://example.com/web1/M00/a.step',
    'https://user:pass@file.eda.cn/web1/M00/a.step',
    'https://file.eda.cn:444/web1/M00/a.step',
    'https://file.eda.cn/web1/M00/a.step?download=1',
    'https://file.eda.cn/web1/M00/a.step#secret',
    'https://file.eda.cn/web1/M00/folder/../a.step',
    'https://file.eda.cn/web1/M00/a.zip',
  ]) {
    const { service, calls } = fixture((u) =>
      u.endsWith('/productDetail')
        ? json({ ...product, cadUrlList: [...product.cadUrlList, { type: '3d', fileUrl: url }] })
        : undefined,
    );
    try {
      const detail = await service.request({ action: 'detail', kind: 'footprints', id });
      assert.equal(JSON.stringify(detail).includes(url), false);
      await assert.rejects(service.modelBytes(id, 0), /HTTPS source/);
      assert.deepEqual(
        calls.map(({ url: called }) => called),
        [`${origin}/api/chiplet/kicad/productDetail`, footprintUrl],
      );
    } finally {
      service.close();
    }
  }
});

test('NextPCB STEP responses enforce announced and streamed byte limits, STEP headers and retryability', async () => {
  const modelUrl = 'https://file.eda.cn/web2/M00/05/provider.stp';
  for (const bad of [
    () => new Response('<html>not a model</html>'),
    () => new Response('ISO-10303-21;', { headers: { 'content-length': '33554433' } }),
    () => new Response(new Uint8Array(33_554_433)),
  ]) {
    let attempts = 0;
    const { service } = fixture((url) => {
      if (url.endsWith('/productDetail'))
        return json({
          ...product,
          cadUrlList: [...product.cadUrlList, { type: '3d', fileUrl: modelUrl }],
        });
      if (url === footprintUrl)
        return new Response(
          footprint.replace(
            /\)$/,
            ' (model "${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step"))',
          ),
        );
      if (url === modelUrl) return ++attempts === 1 ? bad() : new Response('ISO-10303-21;\nDATA;');
    });
    try {
      await assert.rejects(service.modelBytes(id, 0), /invalid STEP|size limit/);
      assert.equal((await service.modelBytes(id, 0)).toString(), 'ISO-10303-21;\nDATA;');
    } finally {
      service.close();
    }
  }
});

test('NextPCB STEP requests share concurrency limits and abort on caller cancellation or shutdown', async () => {
  const modelUrl = 'https://file.eda.cn/web1/M00/test.step';
  const { service } = fixture((url, options) => {
    if (url.endsWith('/productDetail'))
      return json({
        ...product,
        cadUrlList: [...product.cadUrlList, { type: '3d', fileUrl: modelUrl }],
      });
    if (url === footprintUrl)
      return new Response(
        footprint.replace(
          /\)$/,
          ' (model "${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8.step"))',
        ),
      );
    if (url === modelUrl)
      return new Promise((_, reject) =>
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        }),
      );
  });
  try {
    await service.request({ action: 'detail', kind: 'footprints', id });
    const controller = new AbortController();
    const first = service.modelBytes(id, 0, controller.signal);
    const rest = Array.from({ length: 7 }, () => service.modelBytes(id, 0));
    await assert.rejects(service.modelBytes(id, 0), /Too many NextPCB/);
    controller.abort();
    await assert.rejects(first, /cancelled/);
    service.close();
    await Promise.all(rest.map((p) => assert.rejects(p, /cancelled/)));
    await assert.rejects(service.modelBytes(id, 0), /closed/);
  } finally {
    service.close();
  }
});

test('NextPCB size limits cover announced and streamed bytes; oversized pages and future versions reject', async () => {
  for (const response of [
    new Response('{}', { headers: { 'content-length': '2000001' } }),
    new Response('x'.repeat(2_000_001)),
    json(
      Array.from({ length: 51 }, () => row),
      { total: 51 },
    ),
  ]) {
    const { service } = fixture(() => response);
    try {
      await assert.rejects(
        service.request({ action: 'search', kind: 'symbols', query: 'LM358' }),
        /size limit|invalid search page/,
      );
    } finally {
      service.close();
    }
  }
  const { service } = fixture((url) =>
    url === footprintUrl ? new Response(footprint.replace('20240108', '99999999')) : undefined,
  );
  try {
    assert.match(
      (await service.request({ action: 'detail', kind: 'symbols', id })).warning,
      /footprint version/,
    );
    await assert.rejects(
      service.request({ action: 'detail', kind: 'footprints', id }),
      /footprint version/,
    );
  } finally {
    service.close();
  }
});

test('NextPCB close and caller cancellation abort network work and do not retain late results', async () => {
  let signal: AbortSignal | undefined;
  const { service } = fixture((_url, options) => {
    signal = options.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }),
    );
  });
  const control = new AbortController();
  const pending = service.request({
    action: 'search',
    kind: 'symbols',
    query: 'LM358',
    signal: control.signal,
  });
  control.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(signal?.aborted, true);
  const closing = service.request({ action: 'search', kind: 'symbols', query: 'LM358' });
  service.close();
  await assert.rejects(closing, /cancelled/);
  await assert.rejects(service.request({ action: 'search', kind: 'symbols' }), /closed/);
});
