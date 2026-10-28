import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseCircuit } from '../lib/circuit';
import { child, children, val } from '../lib/sexpr';
import { partFields, unitGraphics } from '../lib/library';
import { schematicTexts } from '../lib/schematic-text';
import manifest from '../tests/fixtures/kicad/manifest.json';
import lock from '../resources/example-models-lock.json';

// Reproducible profile metadata only. Vendor model bytes stay in the verified private cache.
// Preparation directory must contain original files fetched from lock.models[].url.
const profiles = [];
const timings: Record<string, [number, number]> = {
  'kicad-rectifier': [0.01, 1e-6],
  'kicad-boost': [0.02, 1e-6],
  'kicad-royer': [0.005, 2e-7],
  'kicad-high-voltage': [0.005, 2e-7],
  'kicad-lm317': [0.5, 5e-5],
  'kicad-class-d': [0.002, 2e-7],
  'kicad-laser-driver': [150e-9, 1e-11],
  'kicad-generic-opamp': [0.01, 1e-6],
};
const definitions = new Map<string, string>();
for (const model of lock.models) {
  const bytes = await readFile(`test-results/example-models/${model.file}`);
  if (createHash('sha256').update(bytes).digest('hex') !== model.sha256)
    throw new Error(`${model.file}: model hash mismatch.`);
  definitions.set(model.file, bytes.toString('latin1'));
}
for (const entry of manifest.examples.filter((e) => e.id !== 'kicad-buck')) {
  const source = await readFile(`tests/fixtures/kicad/upstream/${entry.file}`, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== entry.sha256)
    throw new Error(`${entry.id}: schematic hash mismatch.`);
  const d = parseCircuit(source);
  const parts = d.parts.map((p) => {
    const lib = d.libraries[p.libId];
    const fields = {
      ...Object.fromEntries(children(lib, 'property').map((v) => [val(v), val(v, 2)])),
      ...partFields(p),
    };
    const sim = Object.fromEntries(
      Object.entries(fields).filter(([key]) => /^Sim\.|^Spice_/i.test(key)),
    );
    const pins = unitGraphics(lib, p.unit || 1).flatMap((s) => children(s, 'pin'));
    const signature = pins
      .map((pin) =>
        JSON.stringify([
          val(child(pin, 'number')),
          child(pin, 'at')?.slice(1),
          child(pin, 'length')?.slice(1),
          pin[1],
        ]),
      )
      .sort()
      .join('|');
    let kind = '',
      terminals: string[] = [],
      modelId = '',
      modelName = '';
    if (sim['Sim.Library']) {
      const file = sim['Sim.Library'].split('/').at(-1)!;
      const model = lock.models.find((m) => m.file === file)!;
      if (!model) throw new Error(`Missing model ${file}`);
      const name = sim['Sim.Name'];
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = definitions.get(file)!;
      const sub = body.match(new RegExp(`^\\s*\\.subckt\\s+${escaped}\\s+([^\\r\\n]+)`, 'im'));
      const device = body.match(new RegExp(`^\\s*\\.model\\s+${escaped}\\s+(\\w+)`, 'im'));
      modelId = model.id;
      modelName = name;
      if (sub) {
        kind = 'X';
        terminals = sub[1]
          .split(/params\s*:/i)[0]
          .trim()
          .split(/\s+/);
      } else if (device) {
        kind = /^(NPN|PNP)$/i.test(device[1]) ? 'Q' : 'D';
        terminals = kind === 'Q' ? ['C', 'B', 'E'] : ['A', 'K'];
      } else throw new Error(`${name}: missing model definition.`);
    } else if (pins.length === 1) {
      kind = 'power';
      terminals = [val(child(pins[0], 'number'))];
    } else if (
      /^Device:([RCL])(?:_Small)?$/.test(p.libId) ||
      /:(R|C)$/.test(p.libId) ||
      /^L_Small_/.test(p.libId)
    ) {
      kind = p.ref[0];
      terminals = ['+', '-'];
    } else if (sim['Sim.Device'] === 'V') {
      kind = 'V';
      terminals = ['+', '-'];
    } else if (sim['Sim.Device'] === 'D') {
      kind = 'D';
      terminals = ['A', 'K'];
    } else if (sim['Sim.Device'] === 'NMOS') {
      kind = 'M';
      terminals = ['D', 'G', 'S'];
    } else if (['NPN', 'PNP'].includes(sim['Sim.Device'])) {
      kind = 'Q';
      terminals = ['C', 'B', 'E'];
    } else throw new Error(`${entry.id}/${p.ref}: missing kind.`);
    // Preserve original mappings, including tied terminals and exact duplicate legacy entries.
    const mapping = [
      ...new Set(
        (sim['Sim.Pins'] || terminals.map((t, i) => `${i + 1}=${t}`).join(' ')).split(/\s+/),
      ),
    ];
    const pinOrder = terminals.map((terminal, index) => {
      const item =
        mapping.find((v) => v.split('=')[1] === terminal) ||
        mapping.find((v) => v.split('=')[1] === String(index + 1));
      if (!item) throw new Error(`${entry.id}/${p.ref}: missing terminal ${terminal}`);
      return item.split('=')[0];
    });
    return {
      ref: p.ref,
      libId: p.libId,
      signature,
      kind,
      terminals,
      pinOrder,
      sim,
      modelId,
      modelName,
      value: p.value,
    };
  });
  const options: Record<string, string> = {};
  for (const text of schematicTexts(d.original)) {
    for (const line of text.text.split(/\r?\n/).filter((s) => /^\.options?\s/i.test(s))) {
      for (const match of line.matchAll(/\b(chgtol|abstol|reltol|method)=([a-z\d.+-]+)/gi))
        options[match[1].toLowerCase()] = match[2];
    }
  }
  profiles.push({
    id: entry.id,
    title: entry.title,
    stop: timings[entry.id][0],
    step: timings[entry.id][1],
    parts,
    options,
    directives: schematicTexts(d.original)
      .map((t) => t.text)
      .filter((s) => /(^|\n)\s*(?:\.|K\d+\s)/i.test(s)),
  });
}
await writeFile('lib/example-simulation.json', JSON.stringify({ profiles }, null, 2) + '\n');
console.log(
  `Generated ${profiles.length} simulation profiles with pinned models and electrical signatures.`,
);
