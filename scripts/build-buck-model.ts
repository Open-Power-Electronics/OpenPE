import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseCircuit } from '../lib/circuit';
import { unitGraphics } from '../lib/library';
import { child, children, val } from '../lib/sexpr';

// Upstream KiCad 10 demo data, CC BY-SA 4.0; never hand-edit the generated snapshot.
const model = await readFile('resources/spice/IRF-Power-VDMOS.mod', 'utf8');
const source = await readFile('tests/fixtures/kicad/upstream/buck_conv.kicad_sch', 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
if (
  hash(model) !== '840295ba890baad25b3921fb9ab17f6174cf9673f58fde37f26bc3ca1cdde596' ||
  hash(source) !== 'e2ddd9d1a947b9ed06557b09fcf4f611cdafe36641396b5cbe3974938b608397'
)
  throw new Error('Buck model or upstream schematic hash mismatch.');
const circuit = parseCircuit(source);
const pins = Object.fromEntries(
  Object.entries(circuit.libraries).map(([id, lib]) => [
    id,
    unitGraphics(lib)
      .flatMap((s) => children(s, 'pin'))
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
  ]),
);
const definition = model.split(/\r?\n/).find((line) => /^\.model IRF540N vdmos /i.test(line));
if (!definition) throw new Error('Missing IRF540N model.');
await writeFile(
  'lib/buck-simulation.json',
  JSON.stringify(
    {
      source: 'KiCad/kicad-source-mirror@0feeca2a807f428ad2b3fa7c1e39625cb769f02c',
      license: 'CC-BY-SA-4.0',
      modelSha256: hash(model),
      definition,
      pins,
    },
    null,
    2,
  ) + '\n',
);
