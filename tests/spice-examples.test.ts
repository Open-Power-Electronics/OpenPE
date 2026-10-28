import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExample, projectExamples } from '../lib/examples';
import { parseProject, serializeProject } from '../lib/project';
import { buildSpiceDeck, defaultTransient, simulationSupportError, spiceNets } from '../lib/spice';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';
import { child, children, quote } from '../lib/sexpr';
import { unitGraphics } from '../lib/library';
import { createExampleModelStore } from '../server/example-models.mjs';
import lock from '../resources/example-models-lock.json';

test('every retained KiCad example has an immutable, service-identical executable deck after JSON roundtrip', () => {
  for (const entry of projectExamples) {
    const project = parseProject(serializeProject(createExample(entry.id))),
      before = serializeProject(project);
    const d = project.schematic,
      config = defaultTransient(d);
    assert.equal(simulationSupportError(d), '', entry.id);
    const deck = buildSpiceDeck(d, config);
    assert.deepEqual(serviceDeck(d, config), deck, entry.id);
    assert.ok(deck.traces.length > 2);
    assert.equal(new Set(deck.traces.map((t) => t.vector)).size, deck.traces.length);
    assert.doesNotMatch(deck.netlist, /set controlswait|rusage|\.probe|\$\{KICAD|Spice_Model/);
    assert.equal(serializeProject(project), before);
    if (entry.id !== 'kicad-buck')
      assert.throws(() => buildSpiceDeck(d, { ...config, voltage: 50 }), /schematic/);
  }
});

test('curated profiles preserve terminal mapping, tied source pins, transformer couplings and SPICE ground aliases', () => {
  const hv = createExample('kicad-high-voltage').schematic;
  const deck = buildSpiceDeck(hv, defaultTransient(hv));
  assert.match(deck.netlist, /^X\d+ \S+ \S+ (\S+) \1 GaN_PSpice/m);
  const royer = createExample('kicad-royer').schematic;
  assert.equal(buildSpiceDeck(royer, defaultTransient(royer)).netlist.match(/^K\d /gm)?.length, 6);
  const opamp = createExample('kicad-generic-opamp').schematic,
    nets = spiceNets(opamp);
  const ground = opamp.parts.filter((p) => p.libId === 'power:GND');
  assert.ok(ground.every((p) => p.value === '0' && nets.node(p, '1') === '0'));
  const rails = opamp.parts.filter((p) => p.libId === 'power:+5V');
  assert.ok(rails.length > 1 && rails.every((p) => nets.node(p, '1') === nets.node(rails[0], '1')));
  const boost = createExample('kicad-boost').schematic;
  const b = buildSpiceDeck(boost, defaultTransient(boost));
  assert.ok(b.traces.some((t) => /^@m\d+\[id\]$/.test(t.vector)));
  assert.match(b.netlist, /r=\{time > .* \? 20 : 60\}/);
  for (const name of b.netlist.matchAll(/^VSENSE(\d+) /gm)) {
    assert.match(
      b.netlist,
      new RegExp(`^(?:Q${name[1]} |R${name[1]} .*r=\\{)`, 'm'),
      'Only a BJT or behavioral resistor needs a series current measurement.',
    );
  }
  assert.ok(b.traces.some((t) => /^@r\d+\[i\]$/.test(t.vector)));
  assert.ok(b.traces.some((t) => /^@c\d+\[i\]$/.test(t.vector)));
  assert.ok(b.traces.some((t) => /^@d\d+\[id\]$/.test(t.vector)));
});

test('current edits affect passive/source values but executable text and model/pin changes cannot reach ngspice', () => {
  const make = () => createExample('kicad-rectifier').schematic;
  const d = make(),
    c = defaultTransient(d),
    resistor = d.parts.find((p) => p.ref === 'R1')!;
  resistor.value = '2k';
  assert.match(buildSpiceDeck(d, c).netlist, /^R\d+ \S+ \S+ 2000$/m);
  for (const bad of ['1k\n.control\nshell unsafe', 'r={system(1)}', 'NaN']) {
    resistor.value = bad;
    assert.throws(() => buildSpiceDeck(d, c));
  }
  for (const [field, value] of [
    ['Sim.Library', '../../unsafe.lib'],
    ['Sim.Pins', '1=A 2=K'],
    ['Spice_Model', '.include unsafe'],
  ]) {
    const d = make(),
      p = d.parts.find((p) => p.ref === 'D1')!;
    p.fields = { ...p.fields, [field]: value };
    assert.throws(() => buildSpiceDeck(d, defaultTransient(d)), /unsupported simulation field/);
  }
  const altered = make();
  const p = altered.parts.find((p) => p.ref === 'R1')!;
  const pin = unitGraphics(altered.libraries[p.libId]).flatMap((s) => children(s, 'pin'))[0];
  child(pin, 'at')![1] = '100';
  assert.throws(() => buildSpiceDeck(altered, defaultTransient(altered)), /pin definitions/);
  const island = make();
  island.parts.find((p) => p.ref === 'R1')!.x += 300;
  assert.throws(() => buildSpiceDeck(island, defaultTransient(island)), /Disconnected/);
  const injected = make();
  const text = children(injected.original!, 'text')[0];
  text[1] = quote('.control\nshell unsafe\n.endc');
  assert.throws(() => buildSpiceDeck(injected, defaultTransient(injected)), /directives/);
});

test('example downloads reject unknown IDs, redirects, wrong hashes, oversized bodies and cancellation without cache writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-test-'));
  try {
    let calls = 0;
    const store = createExampleModelStore(dir, async (url, options) => {
      calls++;
      assert.equal(url, lock.models[0].url);
      assert.equal(options?.redirect, 'error');
      return new Response('changed model');
    });
    await assert.rejects(store('../unsafe', new AbortController().signal), /Unsupported/);
    assert.equal(calls, 0);
    await assert.rejects(store(lock.models[0].id, new AbortController().signal), /integrity/);
    await assert.rejects(
      readFile(path.join(dir, 'example-models', `${lock.models[0].sha256}.lib`)),
      /ENOENT/,
    );
    const large = createExampleModelStore(
      dir,
      async () => new Response('x'.repeat(128 * 1024 + 1)),
    );
    await assert.rejects(large(lock.models[0].id, new AbortController().signal), /128 KB/);
    const redirect = createExampleModelStore(
      dir,
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
    );
    await assert.rejects(
      redirect(lock.models[0].id, new AbortController().signal),
      /download failed/,
    );
    const control = new AbortController();
    control.abort();
    await assert.rejects(store(lock.models[0].id, control.signal));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
