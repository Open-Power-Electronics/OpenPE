import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { createBlankProject } from '../lib/create-blank-project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { registerLibraryCapabilities } from '../lib/library-capabilities';
import { loadLibraryFootprint } from '../lib/library-package';
import { projectFootprintSource } from '../lib/library-project-assets';
import { GerberLayer } from '../lib/manufacturing-gerber';
import { PCBProjectSync } from '../lib/pcb-project-sync';
import { child, children, val, type SExpr } from '../lib/sexpr';
import { createJlcpcbLibrary } from '../server/jlcpcb-library.mjs';
import { createLibraryService } from '../server/libraries.mjs';
import { prepareLibraryPackage } from '../server/component-models.mjs';
import { startServer } from '../server/index.mjs';

const code = 'C123456';
const id = 'JLCPCB:' + code;
const notice = 'Fixture: JLCEDA/EasyEDA Official Library. https://lceda.cn/ https://easyeda.com/';
const catalogUrl =
  'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2';
const cadUrl = `https://easyeda.com/api/products/${code}/components?version=6.4.19.5`;
const symbolUuid = 'a'.repeat(32);
const footprintUuid = 'b'.repeat(32);
const row = {
  componentCode: code,
  componentModelEn: 'Fixture-123',
  componentBrandEn: 'Fixture Devices',
  componentSpecificationEn: 'SMD-2',
  componentTypeEn: 'Test category',
  describe: 'Fixture description',
  dataManualFileAccessIdUrl: 'https://example.invalid/signed-url',
};
const jlcCategories = [
  {
    componentSortKeyId: 9,
    sortName: 'Power Management (PMIC)',
    parentId: 0,
    grade: 1,
    childSortList: [0, 1].map(() => ({
      componentSortKeyId: 71,
      sortName: 'Voltage Regulators',
      parentId: 9,
      grade: 2,
      childSortList: null,
    })),
  },
];
const categories = [
  {
    id: '9',
    name: 'Power Management (PMIC)',
    children: [{ id: '71', name: 'Voltage Regulators', children: [] }],
  },
];
const pin = (number: string, x: string, delta: string, angle: string) =>
  `P~show~0~${number}~${x}~0~${angle}~p${number}~0^^${x}~0^^M ${x} 0 h${delta}~#880000^^1~0~0~0~PIN${number}~start~~7pt^^1~0~0~0~${number}~start~~7pt^^0~0~0^^0~M 0 0`;
const document = () => ({
  success: true,
  code: 0,
  result: {
    uuid: symbolUuid,
    docType: 2,
    lcsc: { number: code },
    dataStr: {
      head: {
        uuid: symbolUuid,
        docType: '2',
        editorVersion: '6.5.23',
        x: 10,
        y: 0,
        puuid: footprintUuid,
        c_para: { pre: 'U?' },
        license: notice,
      },
      shape: [
        pin('1', '-10', '10', '180'),
        pin('2', '30', '-10', '0'),
        'R~0~-4~~~20~8~#880000~1~0~none~r1~0',
      ],
    },
    packageDetail: {
      uuid: footprintUuid,
      docType: 4,
      dataStr: {
        head: {
          uuid: footprintUuid,
          docType: '4',
          editorVersion: '6.5.23',
          x: 4000,
          y: 3000,
          license: notice,
        },
        shape: [
          'PAD~RECT~3996~3000~3.0001~5~1~~1~0~~0~p1~0~~Y~0~0.1~0.2',
          'PAD~OVAL~4004~3000~3~5~1~~2~0~~90~p2~0~~Y~0~0~0.2',
          'TRACK~0.6~3~~3998 2997 4002 2997~g1~0',
          'ARC~0.6~3~~M4002,2997 A3,3 0 0 1 4002,3003~~g2~0',
        ],
      },
    },
  },
});

function fixture(cadResponse?: (partNumber: string) => Response | undefined) {
  const requests: { url: string; body: unknown }[] = [];
  const cad = document();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body && JSON.parse(String(init.body));
    requests.push({ url, body });
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.ok(init?.signal instanceof AbortSignal);
    if (url === catalogUrl) {
      const { currentPage, pageSize, keyword, searchType } = body;
      if (searchType === 1) {
        assert.deepEqual(body, { searchType: 1, pageSize: 0 });
        return Response.json({ code: 200, data: { sortAndCountVoList: jlcCategories } });
      }
      assert.equal(pageSize, 100);
      if (keyword === 'zero')
        return Response.json({
          code: 200,
          data: { componentPageInfo: { total: 0, pageNum: currentPage, pageSize: 0, list: null } },
        });
      const total = keyword === code ? 1 : 250;
      const count = Math.min(pageSize, total - (currentPage - 1) * pageSize);
      const list =
        keyword === code
          ? [row]
          : Array.from({ length: count }, (_, i) => ({
              ...row,
              componentCode: 'C' + (currentPage * 1000 + i),
            }));
      return Response.json({
        code: 200,
        data: {
          componentPageInfo: {
            total,
            pageNum: currentPage,
            pageSize,
            list,
          },
        },
      });
    }
    const partNumber =
      /^https:\/\/easyeda\.com\/api\/products\/(C\d+)\/components\?version=6\.4\.19\.5$/.exec(
        url,
      )?.[1];
    assert.ok(partNumber, 'CAD reads use the fixed EasyEDA endpoint.');
    return (
      cadResponse?.(partNumber) ??
      Response.json({ ...cad, result: { ...cad.result, lcsc: { number: partNumber } } })
    );
  };
  return { fetcher, requests, cad };
}

test('JLCPCB uses fixed hosts, exact IDs and paged keywords without exposing upstream files or tokens', async () => {
  const { fetcher, requests } = fixture();
  const library = createJlcpcbLibrary({ fetcher });
  try {
    await assert.rejects(
      library.request({ action: 'detail', kind: 'symbols', id: 'JLCPCB:C123/elsewhere' }),
      /identity/,
    );
    assert.equal(requests.length, 0);
    const page = await library.request({
      action: 'search',
      kind: 'footprints',
      query: ' fixture ',
      offset: 102,
    });
    assert.deepEqual(requests[0].body, { keyword: 'fixture', currentPage: 2, pageSize: 100 });
    assert.equal(page.total, 250);
    assert.equal(page.entries.length, 98);
    assert.equal(page.nextOffset, 200);
    assert.equal(page.entries[0].id, 'JLCPCB:C2002');
    assert.equal(page.entries[0].manufacturer, 'Fixture Devices');
    assert.equal(page.entries[0].package, 'SMD-2');
    assert.doesNotMatch(JSON.stringify(page), /signed-url/);
    assert.deepEqual(await library.request({ action: 'search', kind: 'symbols', query: 'zero' }), {
      entries: [],
      total: 0,
      nextOffset: null,
      libraries: ['JLCPCB'],
    });
    await library.request({ action: 'search', kind: 'symbols', query: code });
    assert.ok(requests.every((request) => request.url === catalogUrl));
    const symbol = await library.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(symbol.footprint, id);
    assert.equal(symbol.units, 1);
    assert.equal(symbol.warning, undefined);
    assert.deepEqual(symbol.attribution, {
      source: 'JLCEDA/EasyEDA Official Library',
      homepages: ['https://lceda.cn/', 'https://easyeda.com'],
      notice,
    });
    const detail = await library.request({ action: 'detail', kind: 'footprints', id });
    const footprint = detail.footprint as SExpr;
    assert.equal(val(footprint), code);
    assert.deepEqual(
      children(footprint, 'pad').map((pad) => child(pad, 'at')),
      [
        ['at', '-1.016', '0', '0'],
        ['at', '1.016', '0', '90'],
      ],
    );
    assert.deepEqual(child(children(footprint, 'pad')[0], 'solder_mask_margin'), [
      'solder_mask_margin',
      '0.0508',
    ]);
    assert.deepEqual(child(children(footprint, 'pad')[0], 'size'), ['size', '0.762025', '1.27']);
    assert.deepEqual(child(children(footprint, 'fp_arc')[0], 'mid'), ['mid', '1.27', '0']);
    assert.deepEqual(detail.models, []);
    assert.equal(requests.filter((request) => request.url === cadUrl).length, 1);
    assert.equal(
      requests.filter((request) => (request.body as { keyword?: string })?.keyword === code).length,
      1,
    );
    const unit = children(symbol.symbol, 'symbol')[1];
    assert.deepEqual(
      children(unit, 'pin').map((pin) => child(pin, 'at')),
      [
        ['at', '-5.08', '0', '0'],
        ['at', '5.08', '0', '180'],
      ],
    );
  } finally {
    library.close();
  }
});

test('JLCPCB category browsing applies verified parents and children and shares its tree between library kinds', async () => {
  const { fetcher, requests } = fixture();
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const all = { action: 'search', kind: 'symbols' };
    const unfilteredFirst = await library.request(all);
    const unfilteredSecond = await library.request({
      ...all,
      offset: unfilteredFirst.nextOffset,
    });
    assert.equal(unfilteredFirst.entries.length, 100);
    assert.equal(unfilteredSecond.entries.length, 100);
    assert.equal(unfilteredFirst.total, 250);
    assert.equal(unfilteredFirst.entries[0].id, 'JLCPCB:C1000');
    assert.equal(unfilteredSecond.entries[0].id, 'JLCPCB:C2000');
    assert.deepEqual(await library.request({ action: 'categories', kind: 'symbols' }), {
      categories,
    });
    assert.deepEqual(await library.request({ action: 'categories', kind: 'footprints' }), {
      categories,
    });
    const root = await library.request({ action: 'search', kind: 'symbols', category: '9' });
    const leaf = { action: 'search', kind: 'footprints', category: '71', query: 'LDO' };
    const firstPage = await library.request({ ...leaf, offset: 96 });
    const secondPage = await library.request({ ...leaf, offset: firstPage.nextOffset });
    const lastPage = await library.request({ ...leaf, offset: 248 });
    assert.equal(root.entries.length, 100);
    assert.equal(firstPage.entries.length, 4);
    assert.equal(firstPage.nextOffset, 100);
    assert.equal(secondPage.entries[0].id, 'JLCPCB:C2000');
    assert.equal(lastPage.entries.length, 2);
    assert.equal(lastPage.nextOffset, null);
    await assert.rejects(
      library.request({ action: 'search', kind: 'symbols', category: '72' }),
      /available JLCPCB category/,
    );
    assert.deepEqual(
      requests.filter((request) => request.url === catalogUrl).map((request) => request.body),
      [
        { keyword: '', currentPage: 1, pageSize: 100 },
        { keyword: '', currentPage: 2, pageSize: 100 },
        { searchType: 1, pageSize: 0 },
        { keyword: '', currentPage: 1, pageSize: 100, firstSortName: 'Power Management (PMIC)' },
        ...[1, 2, 3].map((currentPage) => ({
          keyword: 'LDO',
          currentPage,
          pageSize: 100,
          firstSortName: 'Power Management (PMIC)',
          secondSortName: 'Voltage Regulators',
        })),
      ],
    );
  } finally {
    library.close();
  }
});

test('JLCPCB keeps metadata paging independent of CAD and omits known absent packages', async () => {
  const { fetcher, requests } = fixture((part) =>
    part === 'C1000' ? Response.json({ success: false, code: 404 }) : undefined,
  );
  const library = createJlcpcbLibrary({ fetcher });
  const search = { action: 'search', kind: 'symbols' };
  try {
    const first = await library.request(search);
    assert.equal(first.entries.length, 100);
    assert.equal(first.nextOffset, 100);
    assert.equal(requests.length, 1);
    const id = first.entries[0].id;
    await assert.rejects(
      library.request({ action: 'detail', kind: 'symbols', id }),
      /No EasyEDA CAD data/,
    );
    const refreshed = await library.request(search);
    assert.equal(refreshed.entries.length, 99);
    assert.equal(refreshed.nextOffset, 100);
    assert.ok(!refreshed.entries.some((entry: { id: string }) => entry.id === id));
    assert.equal(requests.length, 2);
  } finally {
    library.close();
  }
});

test('JLCPCB distinguishes catalog and preview denials and keeps metadata available', async () => {
  let blocked = 'catalog';
  const { fetcher } = fixture();
  const library = createJlcpcbLibrary({
    fetcher: async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(url) === catalogUrl ? 'catalog' : 'cad';
      if (endpoint === blocked) return new Response(null, { status: 403 });
      return fetcher(url, init);
    },
  });
  const search = { action: 'search', kind: 'symbols', query: code };
  try {
    await assert.rejects(library.request(search), /JLCPCB denied the request \(HTTP 403\)/);
    blocked = 'cad';
    const page = await library.request(search);
    assert.equal(page.entries[0].id, id);
    const preview = { action: 'detail', kind: 'symbols', id };
    await assert.rejects(library.request(preview), /EasyEDA denied the request \(HTTP 403\)/);
    assert.deepEqual(await library.request(search), page);
    blocked = '';
    assert.equal((await library.request(preview)).id, id);
  } finally {
    library.close();
  }
});

test('unsupported manufacturing geometry and mismatched linked CAD remain retryable', async () => {
  const { fetcher, cad } = fixture();
  const library = createJlcpcbLibrary({ fetcher });
  const packageDocument = cad.result.packageDetail.dataStr;
  try {
    packageDocument.shape.push('SOLIDREGION~5~~M 0 0 L 1 0 A 1 1 0 0 1 0 1 Z~solid');
    const symbol = await library.request({ action: 'detail', kind: 'symbols', id });
    assert.match(symbol.warning, /Unsupported front paste region path/);
    assert.equal(symbol.footprint, id);
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      /Unsupported front paste region path/,
    );
    packageDocument.shape.pop();
    packageDocument.head.uuid = 'c'.repeat(32);
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      /Unsupported library document/,
    );
    packageDocument.head.uuid = footprintUuid;
    const detail = await library.request({ action: 'detail', kind: 'footprints', id });
    assert.equal(detail.id, id);
  } finally {
    library.close();
  }
});

test('JLCPCB opens supported STEP previews on demand and materializes portable references on use', async () => {
  const { fetcher, cad } = fixture();
  const uuid = 'd'.repeat(32);
  cad.result.packageDetail.dataStr.shape.push(
    'SVGNODE~' +
      JSON.stringify({
        layerid: '19',
        attrs: {
          c_etype: 'outline3D',
          uuid,
          c_origin: '4000,3000',
          c_rotation: '0,0,0',
          z: '0',
          transform: 'scale(1) translate(0, 0)',
        },
      }),
  );
  const step = 'ISO-10303-21;\nEND-ISO-10303-21;\n';
  let modelReads = 0;
  let missing = false;
  const libraries = createLibraryService({
    jlcpcbFetcher: async (url, options) => {
      if (!String(url).startsWith('https://modules.easyeda.com/')) return fetcher(url, options);
      assert.equal(url, `https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/${uuid}`);
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      modelReads++;
      return missing ? new Response(null, { status: 404 }) : new Response(step);
    },
    stepParserPool: {
      run: async (bytes: Buffer) => {
        assert.equal(bytes.toString(), step);
        return { meshes: [] };
      },
      close() {},
    },
  });
  const modelPath = '${KIPRJMOD}/models/' + 'e'.repeat(64) + '.step';
  let imports = 0;
  const store = {
    async importBytes(bytes: Buffer) {
      assert.equal(bytes.toString(), step);
      imports++;
      return { path: modelPath };
    },
  };
  try {
    await libraries.request({ action: 'search', library: 'JLCPCB', kind: 'footprints' });
    const detail = await libraries.request({ action: 'detail', kind: 'footprints', id });
    assert.equal(detail.models.length, 1);
    assert.equal(modelReads, 0);
    await libraries.model(id, 0);
    assert.equal(modelReads, 1);
    assert.equal(imports, 0);
    const prepared = await prepareLibraryPackage(
      libraries,
      store,
      id,
      new AbortController().signal,
    );
    assert.equal(prepared.models[0].path, modelPath);
    assert.equal(val(child(prepared.footprint, 'model')), modelPath);
    assert.equal(modelReads, 2);
    assert.equal(imports, 1);
    missing = true;
    const packageOnly = await prepareLibraryPackage(
      libraries,
      store,
      id,
      new AbortController().signal,
    );
    assert.deepEqual(packageOnly.models, []);
    assert.equal(children(packageOnly.footprint, 'pad').length, 2);
  } finally {
    libraries.close();
  }
});

test('JLCPCB uses the authenticated Agent and GUI catalog and adopts a portable footprint in the originating undo', async () => {
  const { fetcher, requests, cad } = fixture();
  const symbolDocument = cad.result.dataStr;
  symbolDocument.head.editorVersion = '6.3.0.5';
  symbolDocument.shape.push('A~M -5 0 A 5 4 0 0 1 5 0~~#800~1~0~none');
  const packageShapes = cad.result.packageDetail.dataStr.shape;
  for (const i of [0, 1]) {
    const fields = packageShapes[i].split('~');
    fields[17] = '-5';
    packageShapes[i] = fields.join('~');
  }
  packageShapes.push(
    'SOLIDREGION~5~~M 3995 2999 L 3997 2999 L 3998 3000 L 3997 3001 L 3995 3001 Z~solid',
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-jlcpcb-'));
  const server = await startServer({ dataDir: directory, jlcpcbFetcher: fetcher });
  const sync = new PCBProjectSync();
  const core = new ProjectCore(createBlankProject(), {
    prepare: (next) => sync.prepare(next)?.project ?? next,
  });
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const unregister = registerLibraryCapabilities(host, core);
  const previousWindow = globalThis.window;
  Object.assign(globalThis, {
    window: { openpe: { connection: async () => ({ base: server.base, token: server.token }) } },
  });
  const baseline = core.getNativeFiles();
  try {
    const route = server.base + '/api/libraries/symbols?library=JLCPCB&q=' + code;
    assert.equal((await fetch(route)).status, 401);
    assert.equal(
      (
        await fetch(route, {
          headers: { 'X-OpenPE-Token': server.token, Origin: 'https://example.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(requests.length, 0);
    const args = { kind: 'symbols', library: 'JLCPCB' };
    const gui = await host.query('library.search', args);
    assert.equal((gui as { entries: unknown[] }).entries.length, 100);
    assert.deepEqual(await host.query('library.search', args, { actor: 'agent' }), gui);
    assert.deepEqual(
      await host.query(
        'library.categories',
        { kind: 'symbols', source: 'JLCPCB' },
        { actor: 'agent' },
      ),
      { categories },
    );
    const filtered = await host.query(
      'library.search',
      { ...args, query: '', category: '71' },
      { actor: 'agent' },
    );
    assert.equal((filtered as { total: number }).total, 250);
    assert.deepEqual(core.getNativeFiles(), baseline);
    const detail = (await host.query(
      'library.detail',
      { kind: 'symbols', id },
      { actor: 'agent' },
    )) as {
      id: string;
      symbol: SExpr;
      warning?: string;
    };
    assert.equal(detail.id, id);
    assert.equal(detail.warning, undefined);
    const polyline = child(children(detail.symbol, 'symbol')[0], 'polyline');
    assert.ok(polyline);
    const vertices = children(polyline[1] as SExpr, 'xy');
    assert.deepEqual(vertices[0], ['xy', '-3.81', '0']);
    assert.deepEqual(vertices.at(-1), ['xy', '-1.27', '0']);
    assert.ok(vertices.some((point) => Number(point[2]) > 1.015));
    const prepared = await loadLibraryFootprint(id);
    sync.sources.set(id, prepared);
    try {
      const schematicId = core.getSnapshot().project!.schematic.id;
      await host.execute(
        'schematic.place',
        { schematicId, libraryId: id, x: 0, y: 0 },
        { actor: 'agent' },
      );
      const current = core.getSnapshot();
      assert.equal(current.undoDepth, 1);
      assert.equal(current.project!.schematic.parts[0].fields?.Footprint, id);
      assert.equal(current.project!.pcb?.footprints.length, 1);
      const native = core.getNativeFiles();
      const asset = native.files.find(
        (file) => file.name === `footprints/JLCPCB.pretty/${code}.kicad_mod`,
      );
      assert.ok(asset);
      assert.ok(asset.source.includes(notice));
      assert.match(asset.source, /fp_poly[\s\S]*\(layer "F\.Paste"\)/);
      const reopened = projectFromNativeFiles(native).pcb!.footprints[0];
      const aperture = reopened.graphics.find((graphic) => graphic.layer === 'F.Paste')!;
      assert.equal(aperture.fill, true);
      assert.equal(aperture.width, 0);
      assert.deepEqual(
        [aperture.start, ...aperture.points!, aperture.end],
        [
          { x: -1.27, y: -0.254 },
          { x: -0.762, y: -0.254 },
          { x: -0.508, y: 0 },
          { x: -0.762, y: 0.254 },
          { x: -1.27, y: 0.254 },
        ],
      );
      const stencil = new GerberLayer('Paste,Top');
      for (const pad of reopened.pads) {
        assert.equal(pad.solderPasteMargin, -1.27);
        stencil.pad(reopened, pad, pad.solderPasteMargin);
      }
      stencil.graphic(aperture);
      assert.match(
        stencil.finish(),
        /G36\*\nX-1270000Y254000D02\*\nX-762000Y254000D01\*\nX-508000Y0D01/,
      );
      assert.equal(stencil.finish().match(/G36\*/g)?.length, 1);
      assert.match(
        native.files.find((file) => file.name === 'fp-lib-table')!.source,
        /JLCPCB\.pretty/,
      );
      assert.equal(projectFootprintSource(current.project!, id)?.id, id);
      core.undo();
      assert.deepEqual(core.getNativeFiles(), baseline);
    } finally {
      sync.sources.delete(id);
    }
  } finally {
    unregister();
    host.dispose();
    Object.assign(globalThis, { window: previousWindow });
    server.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('openpe-jlcpcb-'));
    await rm(directory, { recursive: true, force: true });
  }
});
