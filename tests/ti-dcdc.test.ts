import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTiExample } from '../lib/ti-examples';
import { tiDcdcParts } from '../lib/ti-dcdc';
import { libraries } from '../lib/circuit';
import { createLibraryPart, propertyValue, unitGraphics } from '../lib/library';
import { children, child } from '../lib/sexpr';
import { parseProject, serializeProject, exportKiCad } from '../lib/project';
import { buildSpiceDeck, defaultTransient, spiceNets } from '../lib/spice';
import { createTiModelStore, decodeTiModel } from '../server/ti-models.mjs';
import manifest from './fixtures/kicad/manifest.json';

test('six TI variants retain official symbols, assigned packages and independent project identity', () => {
  assert.equal(tiDcdcParts.length, 6);
  assert.equal(manifest.examples.length, 9);
  for (const entry of tiDcdcParts) {
    const a = createTiExample(entry.id),
      b = createTiExample(entry.id);
    assert.notEqual(a.id, b.id);
    assert.ok(a.schematic.parts.every((p) => !b.schematic.parts.some((q) => p.id === q.id)));
    const restored = parseProject(serializeProject(a));
    assert.deepEqual(restored.extensions, a.extensions);
    const u = restored.schematic.parts.find((p) => p.libId === entry.id)!;
    assert.equal(u.fields?.Footprint, entry.footprint);
    assert.equal(propertyValue(libraries[entry.id], 'Footprint'), entry.footprint);
    assert.ok(exportKiCad(restored, 'schematic').includes(entry.footprint));
    const placed = createLibraryPart(b.schematic, libraries[entry.id], 0, 0);
    assert.equal(placed.fields?.Footprint, entry.footprint);
    const config = defaultTransient(restored.schematic);
    const before = serializeProject(restored);
    const deck = buildSpiceDeck(restored.schematic, config);
    const { node } = spiceNets(restored.schematic);
    assert.equal(node(u, '3'), '0');
    assert.equal(node(u, '5'), '0');
    const vin = node(u, '1'),
      sw = node(u, '2'),
      fb = node(u, '4');
    assert.ok(deck.netlist.includes(`XREG ${vin} ${fb} ${sw} 0 0 ${entry.model.subcircuit}`));
    assert.equal(deck.modelId, entry.model.id);
    assert.ok(!deck.netlist.includes('VPWM'));
    assert.equal(serializeProject(restored), before);
  }
});

test('TI simulation refuses altered pin mappings, custom models, wrong feedback and extra regulators', () => {
  const fresh = () => createTiExample(tiDcdcParts[0].id).schematic;
  const d = fresh();
  const config = defaultTransient(d);
  for (const patch of [
    { voltage: 41 },
    { frequency: 100000 },
    { pwmId: config.inputId },
    { modelId: '../../model' },
    { netlist: '.control' },
  ])
    assert.throws(() => buildSpiceDeck(d, { ...config, ...patch }));
  assert.equal(buildSpiceDeck(d, { ...config, stop: 0.006 }).stop, 0.006);
  const u = d.parts.find((p) => p.id === config.switchId)!;
  u.fields = { ...u.fields, 'Sim.Model': '.include secret' };
  assert.throws(() => buildSpiceDeck(d, config), /custom SPICE/);
  delete u.fields!['Sim.Model'];
  const pin = unitGraphics(d.libraries[u.libId]).flatMap((s) => children(s, 'pin'))[0];
  child(pin, 'number')![1] = '"9"';
  assert.throws(() => buildSpiceDeck(d, config), /modified pin/);
  const wrong = fresh();
  wrong.wires = wrong.wires.filter((w) => w.a.x !== 88.9 || w.a.y !== 48.26);
  assert.throws(() => buildSpiceDeck(wrong, defaultTransient(wrong)), /Connect LM2596/);
  const extra = fresh();
  extra.parts.push(createLibraryPart(extra, libraries[tiDcdcParts[0].id], 0, 0));
  assert.throws(() => buildSpiceDeck(extra, defaultTransient(extra)), /exactly one/);
});

test('TI ZIP decoder verifies the archive and model bytes before returning any content', () => {
  const bytes = Buffer.from('test model fixture');
  const name = Buffer.from('fixture.lib');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(name.length, 26);
  const archive = Buffer.concat([header, name, bytes]);
  const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
  const model = { file: 'fixture.lib', sha256: hash(archive), modelSha256: hash(bytes) };
  assert.deepEqual(decodeTiModel(archive, model), bytes);
  assert.throws(() => decodeTiModel(Buffer.concat([archive, bytes]), model), /integrity/);
  assert.throws(
    () => decodeTiModel(archive, { ...model, modelSha256: '0'.repeat(64) }),
    /verified/,
  );
});

test('TI downloader rejects unknown IDs, external redirects, oversized or changed responses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-ti-test-'));
  try {
    let calls = 0;
    const store = createTiModelStore(root, async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.org/model' },
      });
    });
    const signal = new AbortController().signal;
    await assert.rejects(store('../model', signal), /Unsupported/);
    assert.equal(calls, 0);
    await assert.rejects(store('lm2596-5', signal), /approved source/);
    assert.equal(calls, 1);
    await assert.rejects(
      createTiModelStore(root, async () => new Response('bad'))('lm2596-5', signal),
      /integrity/,
    );
    await assert.rejects(
      createTiModelStore(root, async () => new Response(new Uint8Array(131073)))(
        'lm2596-5',
        signal,
      ),
      /128 KB/,
    );
    await assert.rejects(
      createTiModelStore(root, async () => new Response(null, { status: 404 }))('lm2596-5', signal),
      /404/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
