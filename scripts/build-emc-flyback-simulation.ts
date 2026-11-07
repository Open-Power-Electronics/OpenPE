import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseCircuit, pinPositions } from '../lib/circuit';
import { partFields, unitGraphics } from '../lib/library';
import { child, children, val } from '../lib/sexpr';
import { spiceNets } from '../lib/spice';
import { prepareEmcFlybackValues } from './emc-flyback-values';
import { prepareEmcFlybackModelBindings } from './emc-flyback-model-bindings';
import { prepareEmcFlybackTestbench } from './emc-flyback-testbench';

// Build-time electrical signatures only. The original native files remain the
// independent import source; no source content is discarded by this generator.
const source = await readFile(
  'resources/example-catalog/sources/emc-flyback/design/emc_flyback.kicad_sch',
  'utf8',
);
const manifest = JSON.parse(
  await readFile('resources/example-catalog/sources/emc-flyback/source-manifest.json', 'utf8'),
) as { commit: string; license: string; files: { path: string; sha256: string }[] };
if (
  manifest.commit !== 'e1b9a64ac9ac306647fa30094932fb792d17e373' ||
  manifest.license !== 'CC-BY-4.0'
)
  throw new Error('Review and pin the EMC Flyback source revision before changing its simulation.');
const verify = (path: string, bytes: string) => {
  if (
    manifest.files.find((file) => file.path === path)?.sha256 !==
    createHash('sha256').update(bytes).digest('hex')
  )
    throw new Error(`EMC Flyback pinned source differs: ${path}`);
};
verify('design/emc_flyback.kicad_sch', source);
const d = parseCircuit(source);
prepareEmcFlybackValues(d);
prepareEmcFlybackModelBindings(d);
prepareEmcFlybackTestbench(d);
const nets = spiceNets(d, ['PGND', 'SGND']);
const groups = new Map<string, string[]>();
const parts = d.parts.map((p) => {
  const definitions = unitGraphics(d.libraries[p.libId], p.unit || 1).flatMap((s) =>
    children(s, 'pin'),
  );
  for (const pin of definitions) {
    const number = val(child(pin, 'number'));
    const node = nets.node(p, number);
    groups.set(node, [...(groups.get(node) || []), `${p.ref}.${number}`]);
  }
  return {
    ref: p.ref,
    libId: p.libId,
    value: p.value,
    simulation: Object.fromEntries(
      Object.entries({
        ...Object.fromEntries(
          children(d.libraries[p.libId], 'property').map((property) => [
            val(property),
            val(property, 2),
          ]),
        ),
        ...partFields(p),
      }).filter(([key]) => /^spice|^sim[._]/i.test(key)),
    ),
    pins: definitions
      .map((pin) =>
        JSON.stringify([
          val(child(pin, 'number')),
          child(pin, 'at')?.slice(1),
          child(pin, 'length')?.slice(1),
          pin[1],
        ]),
      )
      .sort()
      .join('|'),
  };
});
const control = await readFile(
  'resources/example-catalog/sources/emc-flyback/simulation/EMC_flyback_control.lib',
  'utf8',
);
verify('simulation/EMC_flyback_control.lib', control);
await writeFile(
  'lib/emc-flyback-simulation.json',
  JSON.stringify(
    {
      sourceCommit: manifest.commit,
      license: manifest.license,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      controlSha256: createHash('sha256').update(control).digest('hex'),
      parts,
      noConnectPins: (d.noConnects || [])
        .map((marker) =>
          d.parts
            .flatMap((p) => {
              const pins = unitGraphics(d.libraries[p.libId], p.unit || 1).flatMap((s) =>
                children(s, 'pin'),
              );
              return pinPositions(p, d.libraries[p.libId]).flatMap((position, i) =>
                Math.abs(position.x - marker.x) < 1e-5 && Math.abs(position.y - marker.y) < 1e-5
                  ? [`${p.ref}.${val(child(pins[i], 'number'))}`]
                  : [],
              );
            })
            .sort()
            .join('|'),
        )
        .sort(),
      groups: [...groups.values()].map((group) => group.sort().join('|')).sort(),
    },
    null,
    2,
  ) + '\n',
);
// Executable model bytes stay in project-local libraries, never TypeScript.
// The control library must remain an exact copy of the pinned upstream source.
const models = [];
for (const [id, name] of [
  ['emc-flyback-control', 'EMC_flyback_control'],
  ['emc-flyback-irf520n', 'EMC_IRF520N'],
  ['emc-flyback-es2d', 'EMC_ES2D'],
  ['emc-flyback-ss510c', 'EMC_SS510C'],
]) {
  const file = `circuits/${name}.lib`;
  const bytes = await readFile(`project/emc-flyback/${file}`);
  if (id === 'emc-flyback-control' && !bytes.equals(Buffer.from(control)))
    throw new Error('EMC Flyback control library must retain the pinned upstream bytes.');
  models.push({ id, file, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(
  'resources/emc-flyback-models-lock.json',
  JSON.stringify({ version: 1, models }, null, 2) + '\n',
);
