import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createCapabilityHost } from '../api/capabilities';
import SymbolGraphic from '../components/SymbolGraphic';
import { ProjectCore } from '../core/project-core';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  pinPositions,
  serializeCircuit,
  uid,
} from '../lib/circuit';
import { createBlankProject } from '../lib/create-blank-project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { createLibraryPart } from '../lib/library';
import { registerLibraryCapabilities } from '../lib/library-capabilities';
import { loadLibraryFootprint } from '../lib/library-package';
import { projectFootprintSource } from '../lib/library-project-assets';
import { exportProjectFile } from '../lib/manufacturing-export';
import { GerberLayer } from '../lib/manufacturing-gerber';
import { createPCBFootprint, flipPCBFootprint, insidePolygon } from '../lib/pcb-layout';
import { boardPolygons, offsetPadPolygons, padPolygon } from '../lib/pcb-polygons';
import { PCBProjectSync } from '../lib/pcb-project-sync';
import { updatePCBFromSchematic } from '../lib/pcb-sync';
import { child, children, parseSExpr, val, type SExpr } from '../lib/sexpr';
import { createJlcpcbLibrary } from '../server/jlcpcb-library.mjs';
import { LibraryAssetUnavailable } from '../server/library-asset-error.mjs';
import { createLibraryService } from '../server/libraries.mjs';
import { prepareLibraryPackage } from '../server/component-models.mjs';
import { startServer } from '../server/index.mjs';

const code = 'C123456';
const id = 'JLCPCB:' + code;
const notice = 'Fixture: JLCEDA/EasyEDA Official Library. https://lceda.cn/ https://easyeda.com/';
const catalogUrl =
  'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2';
const cadUrl = `https://easyeda.com/api/products/${code}/components`;
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
        c_para: { pre: 'U?', Supplier: 'LCSC', 'Supplier Part': code },
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
  const catalogRow = { ...row };
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
          ? [catalogRow]
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
    const partNumber = /^https:\/\/easyeda\.com\/api\/products\/(C\d+)\/components$/.exec(url)?.[1];
    assert.ok(partNumber, 'CAD reads use the fixed EasyEDA international endpoint.');
    const custom = cadResponse?.(partNumber);
    if (custom) return custom;
    if (partNumber === code) return Response.json(cad);
    const response = structuredClone(cad);
    response.result.lcsc.number = partNumber;
    response.result.dataStr.head.c_para['Supplier Part'] = partNumber;
    return Response.json(response);
  };
  return { fetcher, requests, cad, catalogRow };
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

test('EasyEDA silkscreen arcs retain geometry around whitespace and source identifiers', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.packageDetail.dataStr.shape;
  const path = ' M4001.25 3001.75 A0.5 0.5 0 0 0 4001.75 3001.25 ';
  shapes.push(`ARC~0.6~3~S$164~${path}~ ~corner~0`);
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'footprints', id });
    const arc = children(detail.footprint, 'fp_arc')[1];
    assert.deepEqual(child(arc, 'start'), ['start', '0.3175', '0.4445']);
    assert.deepEqual(child(arc, 'mid'), ['mid', '0.407303', '0.407303']);
    assert.deepEqual(child(arc, 'end'), ['end', '0.4445', '0.3175']);
    assert.deepEqual(child(arc, 'layer'), ['layer', '"F.SilkS"']);
    shapes[shapes.length - 1] = `ARC~0.6~10~S$164~${path}~ ~corner~0`;
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id: 'JLCPCB:C1000' }),
      /Footprint graphics cannot have electrical nets/,
    );
  } finally {
    library.close();
  }
});

test('EasyEDA footprint document regions with source identifiers leave manufacturing geometry intact', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.packageDetail.dataStr.shape;
  const path = 'M 3999 2999 L 4001 2999 L 4001 3001 L 3999 3001 Z';
  shapes.push(`SOLIDREGION~12~S$194~${path}~solid~outline~~~~0`);
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'footprints', id });
    assert.deepEqual(detail.pads, ['1', '2']);
    assert.deepEqual(children(detail.footprint, 'fp_poly'), []);
    shapes[shapes.length - 1] = `SOLIDREGION~1~S$194~${path}~solid~outline~~~~0`;
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id: 'JLCPCB:C1000' }),
      /Unsupported footprint layer/,
    );
  } finally {
    library.close();
  }
});

test('EasyEDA dense custom pads retain every vertex within the shared limit', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.packageDetail.dataStr.shape;
  const contour = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const angle = (2 * Math.PI * index) / count;
      return [(4000 + 4 * Math.cos(angle)).toFixed(6), (3000 + 3 * Math.sin(angle)).toFixed(6)];
    });
  const pad = (vertices: string[][]) =>
    `PAD~POLYGON~4000~3000~6~8~1~~2~0~${[...vertices, vertices[0]].flat().join(' ')}~90~p2~0~~Y~0`;
  const vertices = contour(122);
  shapes[1] = pad(vertices);
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'footprints', id });
    const copper = children(detail.footprint, 'pad')[1];
    assert.equal(val(copper, 3), 'custom');
    const polygon = child(child(copper, 'primitives')!, 'gr_poly')!;
    const mm = (value: number) => String(Number((value * 0.254).toFixed(6)));
    assert.deepEqual(
      children(child(polygon, 'pts')!, 'xy'),
      vertices.map(([x, y]) => ['xy', mm(3000 - Number(y)), mm(Number(x) - 4000)]),
    );
    shapes[1] = pad(contour(129));
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id: 'JLCPCB:C1000' }),
      /3–128 vertices/,
    );
  } finally {
    library.close();
  }
});

test('EasyEDA footprints retain multi-contour glyph strokes in long labels', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.packageDetail.dataStr.shape;
  const label = (length: number) => {
    const glyph = Array.from({ length: 40 }, (_, contour) => {
      const x = 4000 + contour;
      const segments = Array.from({ length }, (_, i) => `V ${3001 + i / 10}`);
      return [`M ${x} 3000`, ...segments].join(' ');
    }).join(' ');
    return `TEXT~L~4000~3000~0.8~0~none~3~~8~Non-soldered~${glyph}~~label~0`;
  };
  shapes.push(label(14));
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'footprints', id });
    const glyphs = children(detail.footprint, 'fp_line').slice(1);
    assert.equal(glyphs.length, 560);
    assert.deepEqual(child(glyphs[0], 'start'), ['start', '0', '0']);
    assert.deepEqual(child(glyphs.at(-1)!, 'end'), ['end', '9.906', '0.5842']);
    shapes[shapes.length - 1] = label(40);
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id: 'JLCPCB:C1000' }),
      /Footprint text has too many glyph points/,
    );
  } finally {
    library.close();
  }
});

test('EasyEDA symbol identity follows the verified supplier part number', async () => {
  const { fetcher, cad } = fixture();
  const head = cad.result.dataStr.head;
  head.uuid = 'c'.repeat(32);
  head.c_para['Supplier Part'] = 'C123457';
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const request = { action: 'detail', kind: 'symbols', id };
    await assert.rejects(library.request(request), /Unsupported library document/);
    head.c_para['Supplier Part'] = code;
    assert.equal((await library.request(request)).footprintPreview, '2d');
    assert.equal((await library.request({ ...request, kind: 'footprints' })).id, id);
  } finally {
    library.close();
  }
});

test('EasyEDA symbols keep exact native circles and approximate closed ellipses', async () => {
  const { fetcher, cad } = fixture();
  cad.result.dataStr.shape.push(
    'E~10~0~27.5~15~#880000~1~0~none~ellipse~0',
    'E~10~0~5~5~#880000~1~0~none~circle~0',
    'R~0~-5~1~1~20~10~#880000~1~0~NONE~rectangle~0',
  );
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'symbols', id });
    const [body] = children(detail.symbol, 'symbol');
    assert.deepEqual(child(child(body, 'circle')!, 'radius'), ['radius', '1.27']);
    const corners = children(body, 'arc');
    assert.equal(corners.length, 4);
    assert.ok(corners.every((arc) => val(child(child(arc, 'fill')!, 'type')) === 'none'));
    const outline = child(child(body, 'polyline')!, 'pts')!;
    const vertices = children(outline, 'xy');
    assert.deepEqual(vertices[0], ['xy', '6.985', '0']);
    assert.deepEqual(vertices.at(-1), vertices[0]);
    assert.ok(vertices.length > 4 && vertices.length <= 513);
    for (let index = 1; index < vertices.length; index++) {
      const x = (Number(vertices[index - 1][1]) + Number(vertices[index][1])) / 2;
      const y = (Number(vertices[index - 1][2]) + Number(vertices[index][2])) / 2;
      assert.ok(Math.abs(1 - Math.hypot(x / 6.985, y / 3.81)) * 6.985 <= 0.001);
    }
  } finally {
    library.close();
  }
});

test('EasyEDA symbols preserve filled rounded rectangular outlines', async () => {
  const { fetcher, cad } = fixture();
  cad.result.dataStr.shape.push('R~-40~0~2~2~81~40~#880000~1~0~#FFFFFF~body~0');
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'symbols', id });
    const [body] = children(detail.symbol, 'symbol');
    const graphic = child(body, 'polyline')!;
    assert.deepEqual(child(graphic, 'fill'), ['fill', ['type', 'background']]);
    const vertices = children(child(graphic, 'pts')!, 'xy');
    assert.deepEqual(vertices[0], ['xy', '7.366', '0']);
    assert.deepEqual(vertices.at(-1), vertices[0]);
    const topRightEnd = vertices.findIndex((node) => node.join() === 'xy,7.874,-0.508');
    assert.ok(topRightEnd > 1);
    for (let i = 1; i <= topRightEnd; i++) {
      const x = (Number(vertices[i - 1][1]) + Number(vertices[i][1])) / 2 - 7.366;
      const y = (Number(vertices[i - 1][2]) + Number(vertices[i][2])) / 2 + 0.508;
      assert.ok(Math.abs(0.508 - Math.hypot(x, y)) <= 0.001);
    }
  } finally {
    library.close();
  }
});

test('EasyEDA relay symbols preserve filled near-circular arcs and omit empty arcs', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.dataStr.shape;
  shapes.push(
    'A~M 21 5 A 1 1 0 1 0 21 5~~#880000~1~0~none~empty~0',
    'A~M 21 35 A 1 1 0 1 0 21 35.002~~#880000~1~0~none~contact~0',
    'A~M 51 35 A 1 1 0 1 0 51 35.002~~#880000~1~0~#880000~connected~0',
  );
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'symbols', id });
    const [body] = children(detail.symbol, 'symbol');
    const openArcs = children(body, 'arc');
    assert.equal(openArcs.length, 1);
    assert.deepEqual(child(openArcs[0], 'end'), ['end', '2.794', '-8.890508']);
    const filled = child(body, 'polyline')!;
    assert.deepEqual(child(filled, 'fill'), ['fill', ['type', 'outline']]);
    const vertices = children(child(filled, 'pts')!, 'xy');
    assert.deepEqual(vertices[0], ['xy', '10.414', '-8.89']);
    assert.deepEqual(vertices.at(-2), ['xy', '10.414', '-8.890508']);
    assert.deepEqual(vertices.at(-1), vertices[0]);
    assert.ok(vertices.length > 30 && vertices.length <= 512);
    shapes.push('A~M 0 0 A 1 1 0 1 0 0 1~~#880000~1~0~#880000~wideChord~0');
    await assert.rejects(
      library.request({ action: 'detail', kind: 'symbols', id: 'JLCPCB:C1000' }),
      /Filled symbol arcs must have a negligible closing chord/,
    );
  } finally {
    library.close();
  }
});

test('EasyEDA dashed and dotted symbol strokes survive native conversion and rendering', async () => {
  const { fetcher, cad } = fixture();
  cad.result.dataStr.shape.push(
    'PL~-10 30 -10 -40~#880000~1~1~none~dashed~0',
    'PL~10 30 10 -40~#880000~1~2~none~dotted~0',
  );
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'symbols', id });
    const [body] = children(detail.symbol, 'symbol');
    assert.deepEqual(
      children(body, 'polyline').map((line) => child(child(line, 'stroke')!, 'type')),
      [
        ['type', 'dash'],
        ['type', 'dot'],
      ],
    );
    const markup = renderToStaticMarkup(createElement(SymbolGraphic, { library: detail.symbol }));
    assert.match(markup, /<polyline [^>]+stroke-dasharray="1.5 1"/);
    assert.match(markup, /<polyline [^>]+stroke-dasharray="0.2 0.8"/);
  } finally {
    library.close();
  }
});

test('EasyEDA symbols retain mixed pin label visibility and numeric label sizes', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.dataStr.shape;
  shapes[1] = shapes[1]
    .replace('^^1~0~0~0~PIN2~', '^^0~0~0~0~PIN2~')
    .replace('^^1~0~0~0~2~', '^^0~0~0~0~2~');
  shapes.push('T~L~10~3~0~#880000~Times New Roman~10~ ~ ~~comment~Signal~1~start~label~0');
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'symbols', id });
    const [body, unit] = children(detail.symbol, 'symbol');
    const fontSize = (node: SExpr) => child(child(child(node, 'effects')!, 'font')!, 'size');
    assert.deepEqual(fontSize(child(body, 'text')!), ['size', '2.54', '2.54']);
    const hiddenPin = children(unit, 'pin')[1];
    const name = child(hiddenPin, 'name')!,
      number = child(hiddenPin, 'number')!;
    assert.equal(val(name), 'PIN2');
    assert.equal(val(number), '2');
    assert.deepEqual(fontSize(name), ['size', '0', '0']);
    assert.deepEqual(fontSize(number), ['size', '0', '0']);
    const preview = renderToStaticMarkup(createElement(SymbolGraphic, { library: detail.symbol }));
    assert.match(preview, />PIN1<\/text>/);
    assert.match(preview, />1<\/text>/);
    assert.doesNotMatch(preview, />(PIN2|2)<\/text>/);
  } finally {
    library.close();
  }
});

test('EasyEDA repeated physical terminals retain each anchor and share the package net', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.dataStr.shape;
  const repeated = pin('1', '50', '-10', '0');
  shapes.push(repeated);
  cad.result.packageDetail.dataStr.shape.push('PAD~RECT~4012~3000~3~5~1~~1~0~~0~p3~0~~Y~0');
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const { symbol } = await library.request({ action: 'detail', kind: 'symbols', id });
    const footprint = await library.request({ action: 'detail', kind: 'footprints', id });
    const circuit = emptyCircuit();
    circuit.libraries[id] = symbol;
    const part = createLibraryPart(circuit, symbol, 0, 0);
    circuit.parts.push(part);
    const anchors = pinPositions(part, symbol);
    assert.deepEqual(anchors, [
      { x: -5.08, y: 0 },
      { x: 5.08, y: 0 },
      { x: 10.16, y: 0 },
    ]);
    circuit.labels.push({ ...anchors[0], id: uid(), text: 'SHIELD' });
    circuit.wires.push({ id: uid(), a: anchors[1], b: anchors[2] });
    const restored = parseCircuit(serializeCircuit(circuit));
    assert.deepEqual(pinPositions(restored.parts[0], restored.libraries[id]), anchors);
    const { board } = updatePCBFromSchematic(restored, undefined, new Map([[id, footprint]]));
    assert.equal(board.nets[0].name, 'SHIELD');
    assert.deepEqual(
      board.footprints[0].pads.map(({ number, netId }) => [number, netId]),
      [
        ['1', board.nets[0].id],
        ['2', board.nets[0].id],
        ['1', board.nets[0].id],
      ],
    );

    shapes[shapes.length - 1] = repeated.replace('PIN1', 'OTHER');
    await assert.rejects(
      library.request({ action: 'detail', kind: 'symbols', id: 'JLCPCB:C1000' }),
      /conflicting names or electrical types/,
    );
  } finally {
    library.close();
  }
});

test('EasyEDA official subparts load as distinct units of the same native footprint', async () => {
  const source = document();
  const { head, shape } = source.result.dataStr;
  const parameters = { ...head.c_para, name: 'Fixture-123' };
  const subparts = [2, 1].map((unit) => {
    const uuid = (unit === 1 ? 'c' : 'd').repeat(32);
    return {
      uuid,
      dataStr: {
        head: {
          uuid,
          docType: '6',
          editorVersion: head.editorVersion,
          x: unit === 1 ? 10 : 20,
          y: 0,
          puuid: footprintUuid,
          c_para: { ...parameters, pre: `U?.${unit}` },
        },
        shape: [shape[unit - 1], shape[2]],
      },
    };
  });
  const { fetcher } = fixture(() =>
    Response.json({
      ...source,
      result: {
        ...source.result,
        dataStr: { ...source.result.dataStr, head: { ...head, c_para: parameters } },
        subparts,
      },
    }),
  );
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const request = { action: 'detail', kind: 'symbols', id };
    subparts[0].dataStr.head.puuid = 'e'.repeat(32);
    await assert.rejects(library.request(request), /Symbol subpart identity or unit number/);
    subparts[0].dataStr.head.puuid = footprintUuid;
    shape.push(pin('3', '-10', '10', '180'));
    await assert.rejects(library.request(request), /parent symbol drawing has pins missing/);
    shape.pop();
    const detail = await library.request(request);
    const footprint = await library.request({ ...request, kind: 'footprints' });
    assert.equal(detail.units, 2);
    assert.deepEqual(
      children(detail.symbol, 'symbol').map((unit) =>
        children(unit, 'pin').map((pin) => val(child(pin, 'number'))),
      ),
      [['1'], ['2']],
    );
    const circuit = emptyCircuit();
    circuit.libraries[id] = detail.symbol;
    for (const index of [1, 2]) {
      const part = createLibraryPart(circuit, detail.symbol, index * 25.4, 0, index);
      circuit.parts.push(part);
      const [anchor] = pinPositions(part, detail.symbol);
      circuit.labels.push({ ...anchor, id: uid(), text: index === 1 ? 'IN' : 'OUT' });
    }
    const restored = parseCircuit(serializeCircuit(circuit));
    assert.deepEqual(
      restored.parts.map(({ ref, unit }) => [ref, unit]),
      [
        ['U1', 1],
        ['U1', 2],
      ],
    );
    const { board } = updatePCBFromSchematic(restored, undefined, new Map([[id, footprint]]));
    assert.equal(board.footprints.length, 1);
    assert.deepEqual(
      board.footprints[0].pads.map((pad) => board.nets.find((net) => net.id === pad.netId)?.name),
      ['IN', 'OUT'],
    );
  } finally {
    library.close();
  }
});

test('EasyEDA symbol paths retain filled outlines, subpaths and pin anchors', async () => {
  const { fetcher, cad } = fixture();
  cad.result.dataStr.shape.push(
    'PT~M 5 -6 L -5 0 L 5 7 Z ~#880000~1~0~#880000~body~0',
    'PT~M 0 0 q 5 10 10 0 m 3 0 h 4~#880000~1~0~none~marks~0',
  );
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'symbols', id });
    const [body, unit] = children(detail.symbol, 'symbol');
    const [triangle, curve, line] = children(body, 'polyline');
    assert.deepEqual(child(triangle, 'fill'), ['fill', ['type', 'outline']]);
    assert.deepEqual(child(triangle, 'pts'), [
      'pts',
      ['xy', '-1.27', '1.524'],
      ['xy', '-3.81', '0'],
      ['xy', '-1.27', '-1.778'],
      ['xy', '-1.27', '1.524'],
    ]);
    assert.ok(children(child(curve, 'pts')!, 'xy').some((node) => node[2] === '-1.27'));
    assert.deepEqual(child(line, 'pts'), ['pts', ['xy', '0.762', '0'], ['xy', '1.778', '0']]);
    assert.deepEqual(
      children(unit, 'pin').map((node) => child(node, 'at')),
      [
        ['at', '-5.08', '0', '0'],
        ['at', '5.08', '0', '180'],
      ],
    );
  } finally {
    library.close();
  }
});

test('EasyEDA compound filled symbol paths leave the independent footprint available', async () => {
  const { fetcher, cad } = fixture();
  cad.result.dataStr.shape.push('PT~M0 0 H8 V8 H0 Z M2 2 H6 V6 H2 Z~#880000~1~0~#880000~ring');
  const library = createJlcpcbLibrary({ fetcher });
  try {
    await assert.rejects(
      library.request({ action: 'detail', id, kind: 'symbols' }),
      /Filled symbol paths require one closed contour/,
    );
    const detail = await library.request({ action: 'detail', id, kind: 'footprints' });
    assert.deepEqual(detail.pads, ['1', '2']);
  } finally {
    library.close();
  }
});

test('EasyEDA pin paths use the connection dot at either axis endpoint', async () => {
  const { fetcher, cad } = fixture();
  cad.result.dataStr.shape[0] = pin('1', '-10', '10', '180')
    .replace('~1~-10~0~180', '~1~0~0~180')
    .replace('M -10 0 h10', 'M 0 0 h -10');
  cad.result.dataStr.shape[1] = pin('2', '30', '-10', '90').replace('M 30 0 h-10', 'M 30 10 v -10');
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'symbols', id });
    const unit = children(detail.symbol, 'symbol')[1];
    const pins = children(unit, 'pin');
    assert.deepEqual(
      pins.map((node) => child(node, 'at')),
      [
        ['at', '-5.08', '0', '0'],
        ['at', '5.08', '0', '270'],
      ],
    );
    assert.deepEqual(
      pins.map((node) => child(node, 'length')),
      [
        ['length', '2.54'],
        ['length', '2.54'],
      ],
    );
  } finally {
    library.close();
  }
});

test('EasyEDA clock pins retain the native marker, connection anchor and length', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.dataStr.shape;
  shapes[0] = shapes[0].replace('^^0~M 0 0', '^^1~M 0 3 L 3 0 L 0 -3');
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'symbols', id });
    const pin = children(children(detail.symbol, 'symbol')[1], 'pin')[0];
    assert.equal(pin[2], 'clock');
    assert.deepEqual(child(pin, 'at'), ['at', '-5.08', '0', '0']);
    assert.deepEqual(child(pin, 'length'), ['length', '2.54']);
    assert.equal(val(child(pin, 'number')), '1');
    const markup = renderToStaticMarkup(createElement(SymbolGraphic, { library: detail.symbol }));
    assert.match(markup, /M 2\.54 -0\.7 l 0\.9 0\.7 l -0\.9 0\.7/);
    shapes[0] = shapes[0].replace('L 3 0', 'L -3 0');
    await assert.rejects(
      library.request({ action: 'detail', kind: 'symbols', id: 'JLCPCB:C1000' }),
      /Unsupported clock pin marker/,
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

test('A transient EasyEDA 403 retries while JLCPCB metadata stays available', async () => {
  let blocked = 'catalog';
  let deniedAt = 0;
  const { fetcher } = fixture(() => {
    assert.ok(performance.now() - deniedAt >= 1990);
    return undefined;
  });
  const library = createJlcpcbLibrary({
    fetcher: async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(url) === catalogUrl ? 'catalog' : 'cad';
      if (endpoint === blocked) {
        if (endpoint === 'cad') {
          deniedAt = performance.now();
          blocked = '';
        }
        return new Response(null, { status: 403 });
      }
      return fetcher(url, init);
    },
  });
  const search = { action: 'search', kind: 'symbols', query: code };
  try {
    await assert.rejects(library.request(search), /JLCPCB denied the request \(HTTP 403\)/);
    blocked = 'cad';
    const page = await library.request(search);
    assert.equal(page.entries[0].id, id);
    const preview = library.request({ action: 'detail', kind: 'symbols', id });
    assert.deepEqual(await library.request(search), page);
    assert.equal((await preview).id, id);
  } finally {
    library.close();
  }
});

test('JLCPCB spaces concurrent CAD reads and skips cancelled reads waiting for a slot', async () => {
  const startTimes: number[] = [];
  const { fetcher } = fixture(() => {
    startTimes.push(performance.now());
    return undefined;
  });
  const library = createJlcpcbLibrary({ fetcher });
  try {
    await library.request({ action: 'search', kind: 'symbols', query: '' });
    const first = library.request({ action: 'detail', kind: 'symbols', id: 'JLCPCB:C1000' });
    const linked = library.request({ action: 'detail', kind: 'footprints', id: 'JLCPCB:C1000' });
    const second = library.request({ action: 'detail', kind: 'symbols', id: 'JLCPCB:C1001' });
    const control = new AbortController();
    const cancelled = assert.rejects(
      library.request({
        action: 'detail',
        kind: 'symbols',
        id: 'JLCPCB:C1002',
        signal: control.signal,
      }),
      /cancelled or timed out/,
    );
    control.abort();
    const [a, b, packageDetail] = await Promise.all([first, second, linked, cancelled]);
    assert.equal(a.id, 'JLCPCB:C1000');
    assert.equal(b.id, 'JLCPCB:C1001');
    assert.equal(packageDetail.id, a.id);
    assert.equal(startTimes.length, 2);
    assert.ok(startTimes[1] - startTimes[0] >= 990);
  } finally {
    library.close();
  }
});

test('Repeated EasyEDA denials back off and early refreshes leave the deadline unchanged', async (t) => {
  const monotonicNow = performance.now.bind(performance);
  let now: number | undefined;
  t.mock.method(performance, 'now', () => now ?? monotonicNow());
  let blocked = true;
  let cadReads = 0;
  const { fetcher } = fixture(() => {
    cadReads++;
    if (cadReads === 2) now = performance.now();
    if (blocked) return new Response(null, { status: 403 });
  });
  const library = createJlcpcbLibrary({ fetcher });
  const preview = { action: 'detail', kind: 'symbols', id };
  try {
    await assert.rejects(library.request(preview), /Retry in 60 seconds/);
    const deadline = now! + 60_000;
    for (const seconds of [54, 30, 1]) {
      now = deadline - seconds * 1000;
      await assert.rejects(library.request(preview), new RegExp(`Retry in ${seconds} second`));
    }
    assert.equal(cadReads, 2);
    const search = await library.request({ action: 'search', kind: 'symbols', query: code });
    assert.equal(search.entries[0].id, id);
    assert.equal(search.entries[0].footprintPreview, undefined);
    now = deadline;
    await assert.rejects(library.request(preview), /Retry in 120 seconds/);
    assert.equal(cadReads, 3);
    now += 120_000;
    blocked = false;
    assert.equal((await library.request(preview)).id, id);
    assert.equal(cadReads, 4);
  } finally {
    library.close();
  }
});

test('EasyEDA explicit retry follows Retry-After seconds and HTTP dates', async (t) => {
  const wallTime = Date.UTC(2026, 10, 18, 8);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(Date, 'now', () => wallTime + now);
  for (const [status, header] of [
    [403, '15'],
    [429, new Date(wallTime + 15_000).toUTCString()],
  ] as const) {
    now = 0;
    let cadReads = 0;
    const { fetcher } = fixture(() => {
      if (++cadReads === 1)
        return new Response(null, { status, headers: { 'Retry-After': header } });
    });
    const library = createJlcpcbLibrary({ fetcher });
    const preview = { action: 'detail', kind: 'symbols', id };
    try {
      await assert.rejects(
        library.request(preview),
        new RegExp(`HTTP ${status}.*Retry in 15 seconds`),
      );
      now = 4000;
      await assert.rejects(library.request(preview), /Retry in 11 seconds/);
      assert.equal(cadReads, 1);
      now = 15_000;
      assert.equal((await library.request(preview)).id, id);
      assert.equal(cadReads, 2);
    } finally {
      library.close();
    }
  }
});

test('JLCPCB status pages use verified cache entries and leave EasyEDA requests to detail', async (t) => {
  let now = 10_000;
  t.mock.method(performance, 'now', () => now);
  let denied = true;
  let cadReads = 0;
  const { fetcher, catalogRow } = fixture(() => {
    cadReads++;
    if (denied) return new Response(null, { status: 403, headers: { 'Retry-After': '3' } });
  });
  catalogRow.componentModelEn = 'LM2596S-ADJ';
  const libraries = createLibraryService({ jlcpcbFetcher: fetcher });
  try {
    const browse = {
      action: 'search',
      kind: 'symbols',
      library: 'JLCPCB',
      includeAssetStatus: true,
    };
    const first = await libraries.request(browse);
    assert.equal(first.entries.length, 16);
    assert.ok(
      first.entries.every((entry: { footprintPreview?: string }) => !entry.footprintPreview),
    );
    const initialReads = cadReads;
    assert.equal(initialReads, 0, 'Listing devices never probes EasyEDA for uncached rows.');
    const following = await libraries.request({ ...browse, offset: first.nextOffset });
    assert.equal(following.entries.length, 16);
    assert.equal(cadReads, initialReads);

    const preview = { action: 'detail', kind: 'symbols', id };
    await assert.rejects(libraries.request(preview), /EasyEDA CAD denied the request \(HTTP 403\)/);
    const exact = await libraries.request({ ...browse, query: code });
    assert.equal(exact.entries[0].name, 'LM2596S-ADJ');
    assert.equal(exact.entries[0].footprintPreview, undefined);
    assert.equal(cadReads, initialReads + 1);

    denied = false;
    now += 3000;
    assert.equal((await libraries.request(preview)).id, id);
    const checked = await libraries.request({ ...browse, query: code });
    assert.equal(checked.entries[0].footprintPreview, '2d');
    assert.equal(cadReads, initialReads + 2);
  } finally {
    libraries.close();
  }
});

test('unsupported manufacturing geometry and mismatched linked CAD remain retryable', async () => {
  const { fetcher, cad } = fixture();
  const library = createJlcpcbLibrary({ fetcher });
  const packageDocument = cad.result.packageDetail.dataStr;
  try {
    packageDocument.shape.push('SOLIDREGION~5~~M 0 0 L 1 0 R 0 1 Z~solid');
    const symbol = await library.request({ action: 'detail', kind: 'symbols', id });
    assert.match(symbol.warning, /Unsupported SVG path command/);
    assert.equal(symbol.footprintPreview, 'unavailable');
    assert.equal(symbol.footprint, id);
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      (error) =>
        error instanceof LibraryAssetUnavailable &&
        /Unsupported SVG path command/.test(error.message),
    );
    packageDocument.shape.pop();
    packageDocument.shape.push(
      'PAD~POLYGON~4010~3004~4~6~11~~1~1~4007 3002 4013 3006 4013 3002 4007 3006~90~p3~0~~Y~0~~~4010,3004',
    );
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      /custom pad polygon must be simple and non-self-intersecting/i,
    );
    packageDocument.shape.pop();
    packageDocument.shape.push('PAD~RECT~4010~3004~4~6~11~~1~1~~90~p3~0~~Y~0~~~4010,3002');
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      /drill must be smaller than and stay inside its copper pad/,
    );
    packageDocument.shape.pop();
    packageDocument.shape.push('PAD~RECT~4010~3004~4~6~11~~1~1~~0~p3~3~4010 3004 4010.6 3004.8~Y');
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      /slot must follow one of the pad axes/,
    );
    packageDocument.shape.pop();
    packageDocument.shape.push(
      'PAD~OVAL~4010~3004~3~6~11~~2~1~~0~badMount~5~4011 3002.5 4011 3005.5~N',
    );
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      /A non-plated hole must fit its mask opening/,
    );
    packageDocument.shape.pop();
    packageDocument.shape.push('SOLIDREGION~5~~M 0 0 H 10 V 10 H 0 Z M 2 2 H 4 V 4 H 2 Z~solid');
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      /Nested filled contours are unsupported/,
    );
    packageDocument.shape.pop();
    packageDocument.shape.push('SOLIDREGION~5~~M 0 0 L 2 2 L 2 0 L 0 3 Z~solid');
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id }),
      /Filled region edges must not cross or touch/,
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

test('EasyEDA slots retain their tool centreline when the redundant centre differs slightly', async () => {
  const { fetcher, cad } = fixture();
  const shapes = cad.result.packageDetail.dataStr.shape;
  const slot =
    'PAD~RECT~3957.085~3000~11.4173~11.4173~11~~1~3.3465~~0~slot~7.0276~3956.9227 3000 3957.2573 3000~Y~0~0~0.2~';
  shapes[0] = slot + '3957.085,3000';
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const detail = await library.request({ action: 'detail', kind: 'footprints', id });
    const pad = children(detail.footprint, 'pad')[0];
    assert.deepEqual(child(pad, 'at'), ['at', '-10.89914', '0', '0']);
    assert.deepEqual(child(pad, 'drill'), [
      'drill',
      'oval',
      '1.78501',
      '1.700022',
      ['offset', '-0.00127', '0'],
    ]);
    shapes[0] = slot + '3957.08,3000';
    await assert.rejects(
      library.request({ action: 'detail', kind: 'footprints', id: 'JLCPCB:C1000' }),
      /Slot length, centre and endpoints disagree/,
    );
  } finally {
    library.close();
  }
});

test('JLCPCB opens supported STEP previews on demand and materializes portable references on use', async () => {
  const { fetcher, cad } = fixture();
  const [uuid, alternate] = ['d'.repeat(32), 'f'.repeat(32)];
  cad.result.packageDetail.dataStr.shape.push(
    ...[uuid, alternate].map(
      (modelId) =>
        'SVGNODE~' +
        JSON.stringify({
          layerid: '19',
          attrs: {
            c_etype: 'outline3D',
            uuid: modelId,
            c_origin: '3998, 3003',
            c_rotation: '10, -15, 90',
            z: '2.5',
            transform:
              modelId === uuid
                ? 'scale(1) translate(0, 0)'
                : 'scale(1.3703) translate(-1082.8257, -810.9708)',
          },
        }),
    ),
    'SVGNODE~' +
      JSON.stringify({
        layerid: '19',
        attrs: {
          c_etype: 'outline3D',
          uuid: 'e'.repeat(32),
          c_origin: '3998, 3003',
          c_rotation: '10, -15, 90',
          z: '2.5',
          transform: 'scale(-1) translate(0, 0)',
        },
      }),
  );
  const step = 'ISO-10303-21;\nEND-ISO-10303-21;\n';
  let modelReads = 0;
  let modelStatus = 200;
  const libraries = createLibraryService({
    jlcpcbFetcher: async (url, options) => {
      if (!String(url).startsWith('https://modules.easyeda.com/')) return fetcher(url, options);
      const asset = String(url).split('/').at(-1);
      assert.ok(asset === uuid || asset === alternate);
      assert.equal(url, `https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/${asset}`);
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      modelReads++;
      return modelStatus === 200 || asset === alternate
        ? new Response(step)
        : new Response(null, { status: modelStatus });
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
    const symbol = await libraries.request({ action: 'detail', kind: 'symbols', id });
    assert.equal(symbol.footprintPreview, '2d-and-3d');
    assert.equal(detail.models.length, 2);
    assert.equal(modelReads, 0);
    const preview = await libraries.model(id, 1);
    assert.equal(preview.model.path, `JLCPCB:${alternate}.step`);
    assert.deepEqual(preview.model.offset, ['offset', ['xyz', '0.508', '-0.762', '0.635']]);
    assert.deepEqual(preview.model.rotate, ['rotate', ['xyz', '-10', '15', '-90']]);
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
    assert.equal(modelReads, 3);
    assert.equal(imports, 2);
    modelStatus = 503;
    await assert.rejects(libraries.model(id, 0), (error) => {
      assert.match((error as Error).message, /503/);
      return !(error instanceof LibraryAssetUnavailable);
    });
    modelStatus = 403;
    await assert.rejects(libraries.model(id, 0), (error) => {
      assert.match((error as Error).message, /EasyEDA STEP denied the request \(HTTP 403\)/);
      return !(error instanceof LibraryAssetUnavailable);
    });
    const deniedModel = await prepareLibraryPackage(
      libraries,
      store,
      id,
      new AbortController().signal,
    );
    assert.deepEqual(deniedModel.models, [{ ...preview.model, path: modelPath }]);
    assert.equal(children(deniedModel.footprint, 'pad').length, 2);
    assert.equal(deniedModel.projectAssets, true);
    modelStatus = 404;
    await assert.rejects(libraries.model(id, 0), LibraryAssetUnavailable);
    const packageOnly = await prepareLibraryPackage(
      libraries,
      store,
      id,
      new AbortController().signal,
    );
    assert.deepEqual(packageOnly.models, [{ ...preview.model, path: modelPath }]);
    const remaining = child(packageOnly.footprint, 'model');
    assert.ok(remaining);
    assert.deepEqual(child(remaining, 'offset'), preview.model.offset);
    assert.deepEqual(child(remaining, 'rotate'), preview.model.rotate);
    assert.equal(children(packageOnly.footprint, 'pad').length, 2);
  } finally {
    libraries.close();
  }
});

test('verified JLCPCB footprints are independent of symbol artwork and missing catalog package labels', async () => {
  const { fetcher, requests, cad, catalogRow } = fixture();
  catalogRow.componentSpecificationEn = '';
  cad.result.dataStr.shape.push('UNSUPPORTED_GRAPHIC~0');
  const library = createJlcpcbLibrary({ fetcher });
  try {
    const matches = await library.request({ action: 'search', kind: 'footprints', query: code });
    assert.deepEqual(
      matches.entries.map((entry: { id: string }) => entry.id),
      [id],
    );
    await assert.rejects(
      library.request({ action: 'detail', kind: 'symbols', id }),
      /Symbol unavailable: EasyEDA CAD: Unsupported symbol primitive/,
    );
    const detail = await library.request({ action: 'detail', kind: 'footprints', id });
    assert.deepEqual(detail.pads, ['1', '2']);
    assert.equal(requests.filter((request) => request.url === cadUrl).length, 1);
    const circuit = emptyCircuit();
    const part = createPart(circuit, 'R', 0, 0);
    circuit.parts.push(part);
    assert.equal(createPCBFootprint(detail, circuit, part.id, { x: 2, y: 3 }).pads.length, 2);
    const mismatched = structuredClone(detail);
    child(mismatched.footprint, 'pad')![1] = '"9"';
    assert.throws(
      () => createPCBFootprint(mismatched, circuit, part.id, { x: 2, y: 3 }),
      /has no pin 9/,
    );
  } finally {
    library.close();
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
    if (i === 1) {
      fields[6] = '2';
      fields[11] = '31.25';
    }
    packageShapes[i] = fields.join('~');
  }
  packageShapes.push(
    'SOLIDREGION~5~~M 3995 2999 L 3997 2999 L 3998 3000 L 3997 3001 L 3995 3001 Z~solid',
    'SOLIDREGION~6~~m4001,2998 h3 a1,1 0 0 1 0,2 h-1 v-1 h-2 z~solid',
    'SOLIDREGION~3~~3997 2997 4000 2997 3999 2998 4000 2999 3997 2999~solid',
    'SOLIDREGION~7~~M4000 3014 H4002 V3015 H4000 Z~solid~mask1',
    'SOLIDREGION~8~~M4002 3015 H4003 V3016 H4002 Z~solid~mask2',
    'SOLIDREGION~11~~M4012 3010 H4017 V3012 H4012 Z~npth~cutout',
    'CIRCLE~3993~3012~1.5~0.2~10~circle1',
    'RECT~3998~2996~4~1~13~r1~0~0.2~none~~~',
    'HOLE~4000~3008~1.5~h1~0',
    'PAD~POLYGON~4010~3004~4~6~11~~1~1~4007 3002 4013 3002 4013 3006 4007.5 3006 4007 3005.5 4007 3002~90~p3~0~~Y~0~-5~0.5~4010.75,3003.5',
    'PAD~RECT~4018~3004~5~6~11~~1~1~~90~p4~3.5~4018.75 3004.25 4018.75 3002.75~Y~0~-5~~4018.75,3003.5',
    'PAD~OVAL~4008~3012~3~8~11~~1~1~~90~p5~5~4007 3011.5 4010 3011.5~N~0~~~4008.5,3011.5',
    'PAD~POLYGON~3992~3003~6~4~1~~2~0~3989 3001 3995 3001 3995 3005 3994 3005 3994 3004 3989 3004 3989 3001~90~p6~0~~~0~-0.5~0.5',
    'PAD~POLYGON~4022~3008~4~6~11~~1~1~4020 3005 4024 3005 4024 3010 4023 3011 4020 3011~90~p7~4~4022 3009 4022 3007~Y~0~~~4022,3008',
    'TEXT~L~3998~3001~0.5~0~none~3~~2~+~M3998 3002h2 M3999 3001v2~~label~0',
    'TEXT~L~3998~3001~0.5~0~none~3~~2~Hidden~~none~label2~0',
    'SVGNODE~' +
      JSON.stringify({
        layerid: '4',
        nodeType: 1,
        nodeName: 'path',
        attrs: {
          fill: '#000',
          d: 'M4001 3003 q.5 -1 1 0 t1 0 L4003 3004 H4001 Z M4004 3003 C4004.3 3002.6 4004.7 3002.6 4005 3003 s.7 .4 1 0 A0,1 0 0 1 4007 3003 L4007 3004 H4004 Z',
        },
      }),
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
    const initialPage = await fetch(route, { headers: { 'X-OpenPE-Token': server.token } });
    assert.equal(initialPage.status, 200);
    assert.equal(initialPage.headers.get('cache-control'), 'no-store');
    const gui = await host.query('library.search', args);
    assert.equal((gui as { entries: unknown[] }).entries.length, 100);
    assert.deepEqual(await host.query('library.search', args, { actor: 'agent' }), gui);
    const checkedPage = (await host.query('library.search', {
      ...args,
      offset: 95,
      includeAssetStatus: true,
    })) as { entries: Array<{ id: string; footprintPreview?: string }>; nextOffset: number };
    assert.equal(checkedPage.nextOffset, 111);
    assert.equal(checkedPage.entries.length, 16);
    assert.deepEqual(
      checkedPage.entries.map((entry) => entry.footprintPreview),
      Array(16).fill(undefined),
    );
    assert.equal(checkedPage.entries[0].id, 'JLCPCB:C1095');
    assert.equal(checkedPage.entries[5].id, 'JLCPCB:C2000');
    const nextCheckedPage = (await host.query('library.search', {
      ...args,
      offset: checkedPage.nextOffset,
      includeAssetStatus: true,
    })) as typeof checkedPage;
    assert.equal(nextCheckedPage.nextOffset, 127);
    assert.equal(nextCheckedPage.entries.length, 16);
    assert.equal(nextCheckedPage.entries[0].id, 'JLCPCB:C2011');
    assert.equal(nextCheckedPage.entries.at(-1)?.footprintPreview, undefined);
    const requestsBeforeRevisit = requests.length;
    assert.deepEqual(
      await host.query('library.search', { ...args, offset: 95, includeAssetStatus: true }),
      checkedPage,
    );
    assert.equal(requests.length, requestsBeforeRevisit);
    assert.equal(
      (
        await fetch(route + '&includeAssetStatus=true', {
          headers: { 'X-OpenPE-Token': server.token },
        })
      ).status,
      400,
    );
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
      const board = parseSExpr(
        native.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source,
      );
      for (const footprint of [parseSExpr(asset.source), child(board, 'footprint')!]) {
        const pads = children(footprint, 'pad');
        const pad = pads[4];
        assert.deepEqual(child(pad, 'at'), ['at', '4.7625', '0.889', '90']);
        assert.deepEqual(child(pad, 'size'), ['size', '1.27', '1.524']);
        assert.deepEqual(child(pad, 'drill'), [
          'drill',
          'oval',
          '0.889',
          '0.508',
          ['offset', '-0.127', '-0.1905'],
        ]);
        const mechanical = pads[5];
        assert.equal(val(mechanical), '1');
        assert.equal(val(mechanical, 2), 'np_thru_hole');
        assert.deepEqual(child(mechanical, 'at'), ['at', '2.159', '2.921', '90']);
        assert.deepEqual(child(mechanical, 'drill'), [
          'drill',
          'oval',
          '0.508',
          '1.27',
          ['offset', '-0.127', '-0.127'],
        ]);
        assert.equal(child(mechanical, 'net'), undefined);
        for (const custom of pads.slice(6)) {
          assert.equal(val(custom, 3), 'custom');
          assert.deepEqual(child(custom, 'size'), ['size', '0.0001', '0.0001']);
          assert.deepEqual(child(custom, 'options'), [
            'options',
            ['clearance', 'outline'],
            ['anchor', 'rect'],
          ]);
          const primitive = child(child(custom, 'primitives')!, 'gr_poly')!;
          assert.deepEqual(child(primitive, 'fill'), ['fill', 'yes']);
        }
      }
      const reopenedProject = projectFromNativeFiles(native);
      const reopened = reopenedProject.pcb!.footprints[0];
      assert.match(asset.source, /\(layer "Edge\.Cuts"\)/);
      assert.match(asset.source, /\(layer "F\.Mask"\)/);
      assert.match(asset.source, /\(layer "B\.Mask"\)/);
      const edges = reopened.graphics.filter((graphic) => graphic.layer === 'Edge.Cuts');
      assert.deepEqual(
        edges.map((graphic) => [graphic.kind, graphic.fill]),
        [
          ['polygon', false],
          ['circle', false],
        ],
      );
      assert.deepEqual(edges[0].start, { x: 3.048, y: 2.54 });
      assert.deepEqual(edges[0].points, [
        { x: 4.318, y: 2.54 },
        { x: 4.318, y: 3.048 },
      ]);
      const [frontMask, backMask] = reopened.graphics.filter((graphic) =>
        graphic.layer.endsWith('.Mask'),
      );
      assert.deepEqual(
        [frontMask.layer, frontMask.start, frontMask.fill, frontMask.width],
        ['F.Mask', { x: 0, y: 3.556 }, true, 0],
      );
      assert.deepEqual(
        [backMask.layer, backMask.start, backMask.fill, backMask.width],
        ['B.Mask', { x: 0.508, y: 3.81 }, true, 0],
      );
      const fabrication = structuredClone(reopenedProject);
      const corners = [
        { x: reopened.x - 20, y: reopened.y - 20 },
        { x: reopened.x + 20, y: reopened.y - 20 },
        { x: reopened.x + 20, y: reopened.y + 20 },
        { x: reopened.x - 20, y: reopened.y + 20 },
      ];
      fabrication.pcb!.graphics.push(
        ...corners.map((start, i) => ({
          id: uid(),
          layer: 'Edge.Cuts' as const,
          start,
          end: corners[(i + 1) % corners.length],
          width: 0.1,
        })),
      );
      const outline = boardPolygons(fabrication.pcb!);
      assert.equal(outline.length, 1);
      assert.equal(outline[0].holes.length, 2);
      const gerber = new TextDecoder().decode(
        exportProjectFile(fabrication, 'gerber', 'jlc').bytes,
      );
      assert.match(gerber, /jlc\.gts[\s\S]*?TF\.FileFunction,Soldermask,Top\*[\s\S]*?G36\*/);
      assert.match(gerber, /jlc\.gbs[\s\S]*?TF\.FileFunction,Soldermask,Bot\*[\s\S]*?G36\*/);
      assert.match(gerber, /jlc\.gko[\s\S]*?TF\.FileFunction,Profile,NP\*[\s\S]*?D01\*/);
      const backSilk = reopened.graphics.filter((graphic) => graphic.layer === 'B.SilkS');
      assert.equal(backSilk.length, 2);
      assert.ok(backSilk.every((graphic) => graphic.fill && graphic.points!.length > 8));
      assert.deepEqual(reopened.pads[1].layers, ['B.Cu', 'B.Mask', 'B.Paste']);
      assert.equal(reopened.pads[1].rotation, 31.25);
      assert.equal(reopened.pads[2].type, 'np_thru_hole');
      assert.equal(reopened.pads[2].drill, 0.762);
      assert.deepEqual(reopened.pads[2].layers, ['*.Mask']);
      const plated = reopened.pads[3];
      assert.equal(plated.shape, 'roundrect');
      assert.deepEqual(plated.chamfer, ['top_left']);
      assert.equal(plated.chamferRatio, 0.125);
      assert.equal(plated.roundrectRatio, 0);
      assert.equal(plated.solderMaskMargin, 0.127);
      assert.equal(plated.rotation, 90);
      assert.deepEqual(plated.size, { x: 1.016, y: 1.524 });
      assert.deepEqual(plated.drillOffset, { x: 0.127, y: 0.1905 });
      const copper = padPolygon({ ...reopened, x: 0, y: 0 }, plated);
      assert.deepEqual(
        copper.outer.map(({ x, y }) => [Number(x.toFixed(6)), Number(y.toFixed(6))]),
        [
          [1.905, 1.524],
          [1.778, 1.397],
          [1.778, 0.508],
          [3.302, 0.508],
          [3.302, 1.524],
        ],
      );
      const slot = reopened.pads[4];
      assert.equal(slot.drill, 0.508);
      assert.deepEqual(slot.drillSlot, { axis: 'x', length: 0.889 });
      assert.deepEqual(slot.drillOffset, { x: 0.127, y: 0.1905 });
      assert.deepEqual([slot.x, slot.y, slot.rotation], [4.572, 1.016, 90]);
      const mechanical = reopened.pads[5];
      assert.equal(mechanical.number, '1');
      assert.equal(mechanical.type, 'np_thru_hole');
      assert.equal(mechanical.netId, null);
      assert.equal(mechanical.drill, 0.508);
      assert.deepEqual(mechanical.drillSlot, { axis: 'y', length: 1.27 });
      assert.deepEqual(mechanical.drillOffset, { x: 0.127, y: 0.127 });
      assert.deepEqual([mechanical.x, mechanical.y, mechanical.rotation], [2.032, 3.048, 90]);
      const drill = new TextDecoder().decode(
        exportProjectFile(reopenedProject, 'drill', 'jlc').bytes,
      );
      assert.match(drill, /T1C0\.508/);
      assert.ok(
        drill.includes(`X${(reopened.x + 2.7305).toFixed(6)}Y${(-reopened.y - 0.889).toFixed(6)}`),
      );
      const point = (x: number, y: number) =>
        `X${(reopened.x + x).toFixed(6)}Y${(-reopened.y - y).toFixed(6)}`;
      assert.ok(drill.includes(`${point(4.7625, 1.0795)}G85${point(4.7625, 0.6985)}\nG05`));
      assert.ok(drill.includes(`${point(1.778, 2.921)}G85${point(2.54, 2.921)}\nG05`));
      const [custom, customSlot] = reopened.pads.slice(6);
      assert.equal(custom.shape, 'custom');
      assert.deepEqual([custom.x, custom.y, custom.rotation], [-2.032, 0.762, 90]);
      assert.deepEqual(custom.outline, [
        { x: 0.508, y: -0.762 },
        { x: 0.508, y: 0.762 },
        { x: -0.508, y: 0.762 },
        { x: -0.508, y: 0.508 },
        { x: -0.254, y: 0.508 },
        { x: -0.254, y: -0.762 },
      ]);
      const local = { ...reopened, x: 0, y: 0 };
      const customCopper = padPolygon(local, custom);
      assert.equal(insidePolygon({ x: -2.5, y: 0.9 }, customCopper), true);
      assert.equal(insidePolygon({ x: -2.5, y: 1.15 }, customCopper), false);
      assert.equal(offsetPadPolygons(local, custom, custom.solderPasteMargin!).length, 1);
      const paste = new GerberLayer('Paste,Top');
      paste.pad(local, custom, custom.solderPasteMargin);
      assert.match(paste.finish(), /G36\*/);
      const flipped = flipPCBFootprint(reopened);
      assert.deepEqual(
        flipped.pads[6].outline,
        custom.outline!.map(({ x, y }) => ({ x, y: -y })),
      );
      assert.deepEqual(flipped.pads[6].layers, ['B.Cu', 'B.Paste', 'B.Mask']);
      const gerberPoint = (x: number, y: number) =>
        `X${Math.round((reopened.x + x) * 1e6)}Y${Math.round((-reopened.y - y) * 1e6)}`;
      assert.ok(
        gerber.includes(`${gerberPoint(-1.524, 1.27)}D01*\n${gerberPoint(-1.524, 1.016)}D01*`),
      );
      assert.equal(customSlot.shape, 'custom');
      assert.deepEqual(customSlot.drillSlot, { axis: 'x', length: 1.016 });
      assert.ok(drill.includes(`${point(5.588, 2.286)}G85${point(5.588, 1.778)}\nG05`));
      const glyphs = reopened.graphics.filter(
        (graphic) => graphic.layer === 'F.SilkS' && graphic.width === 0.127,
      );
      assert.deepEqual(
        glyphs.map((graphic) => [graphic.start, graphic.end]),
        [
          [
            { x: -0.508, y: 0.508 },
            { x: 0, y: 0.508 },
          ],
          [
            { x: -0.254, y: 0.254 },
            { x: -0.254, y: 0.762 },
          ],
        ],
      );
      const backAperture = reopened.graphics.find((graphic) => graphic.layer === 'B.Paste')!;
      assert.ok(backAperture.points!.length > 16);
      assert.equal(backAperture.fill, true);
      const backStencil = new GerberLayer('Paste,Bot');
      backStencil.graphic(backAperture);
      assert.match(backStencil.finish(), /G36\*/);
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
      for (const pad of reopened.pads.filter(
        (pad) => pad.type !== 'np_thru_hole' && !pad.outline,
      )) {
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
