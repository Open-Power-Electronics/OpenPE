import { switchingStageFixture } from './fixtures/switching-stage';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  await writeFile(
    path.join(root, 'library-index.json'),
    JSON.stringify({
      version: 1,
      catalogs: { symbols: entries, footprints: entries },
      files: [],
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
  } finally {
    service.close();
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
  const service = createLibraryService({ root, dataDir: root });
  const originalFetch = globalThis.fetch;
  let status = 404;
  let cancelled = 0;
  let networkFailures = 0;
  let requests = 0;
  globalThis.fetch = async (url) => {
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
  };
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
    globalThis.fetch = originalFetch;
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
  const service = createLibraryService({ root, dataDir: root });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(
      String(url),
      `https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/10.0.0/${library}.3dshapes/${name.replace(',', '%2C')}.step`,
    );
    assert.equal(options?.redirect, 'error');
    return new Response(null, { status: 404 });
  };
  try {
    await assert.rejects(service.model(`${library}:${name}`, 0), /not available/);
    for (let index = 1; index < references.length; index++)
      await assert.rejects(
        service.model(`${library}:${name}`, index),
        /supported official STEP path/,
      );
    assert.equal(requests, 1, 'Only a validated official model may reach the network.');
  } finally {
    globalThis.fetch = originalFetch;
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});
